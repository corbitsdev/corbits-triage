// Publishes each release's workflows as source assets, one asset per workflow and release holding one commit, through
// Interchange's git smart-HTTP push.
import git, { type FsClient, type HttpClient, type TreeEntry } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createBrowserIsogitRuntime } from "@intx/storage-isogit/browser";
import type { Transport } from "@intx/hub-client";
import { hubOrigin } from "./hub-origin.ts";
import { ensureAsset, portalPackage } from "./workflow-deploy.ts";
import type { SourceIndexEntry, SourceTree } from "./workflow-packages.ts";

const BRANCH = "main";
const REF = `refs/heads/${BRANCH}`;
const TOKEN_LIFETIME_MS = 5 * 60_000;
// A fixed author and time make a release's commit depend only on its tree and the asset's first commit.
const AUTHOR = { name: "Corbits Triage", email: "", timestamp: 0, timezoneOffset: 0 };

/** `dir` holds a local repository per asset; `origin` is the hub's. */
export type SourceGit = { fs: FsClient; http: HttpClient; origin: string; dir: string };
export type PublishedSource = { workflow: string; assetId: string; commitSha: string };
/** The workspace publishing, and its member principal, who must have created every asset it publishes to. */
export type Publisher = { tenantId: string; principalId: string };

let browser: SourceGit | undefined;
let publishing: Promise<void> = Promise.resolve();

// The browser filesystem wipes its store when created, so the page creates it once.
function browserGit(): SourceGit {
  browser ??= { fs: createBrowserIsogitRuntime("corbits-workflow-sources").fs, http, origin: hubOrigin(), dir: "" };
  return browser;
}

async function* onDataBand(report: Uint8Array[]): AsyncIterableIterator<Uint8Array> {
  const encoder = new TextEncoder();
  const size = report.reduce((total, chunk) => total + chunk.length, 0);
  yield encoder.encode((size + 5).toString(16).padStart(4, "0"));
  yield Uint8Array.of(1);
  yield* report;
  yield encoder.encode("0000");
}

// Interchange does not offer side-band-64k on receive-pack and answers a push with bare report-status lines, but
// isomorphic-git reads every push answer as side-band, so the answer is framed on the data band before it reads it.
function bandedPushAnswers(client: HttpClient): HttpClient {
  return {
    async request(request) {
      const response = await client.request(request);
      if (!request.url.endsWith("/git-receive-pack") || !response.body) return response;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) chunks.push(chunk);
      return { ...response, body: onDataBand(chunks) };
    },
  };
}

async function gitToken(transport: Transport, tenantId: string, assetId: string, name: string): Promise<{ id: string; secret: string }> {
  return transport.fetch<{ id: string; secret: string }>("POST", "/api/me/git-tokens", {
    name,
    resource: `asset:${assetId}`,
    refPattern: REF,
    actions: ["can_read", "can_push"],
    expiresAt: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
    tenantId,
  });
}

async function writeTree(fs: FsClient, dir: string, tree: SourceTree): Promise<string> {
  const blobs: TreeEntry[] = [];
  const subtrees = new Map<string, SourceTree>();
  for (const [path, contents] of Object.entries(tree)) {
    const slash = path.indexOf("/");
    if (slash === -1) {
      blobs.push({ mode: "100644", path, type: "blob", oid: await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(contents) }) });
      continue;
    }
    const name = path.slice(0, slash);
    const subtree = subtrees.get(name) ?? {};
    subtree[path.slice(slash + 1)] = contents;
    subtrees.set(name, subtree);
  }
  const trees: TreeEntry[] = [];
  for (const [path, subtree] of subtrees) trees.push({ mode: "040000", path, type: "tree", oid: await writeTree(fs, dir, subtree) });
  return git.writeTree({ fs, dir, tree: [...blobs, ...trees] });
}

async function commitTree(fs: FsClient, dir: string, tree: string, parent: string, message: string): Promise<string> {
  const oid = await git.writeCommit({ fs, dir, commit: { message, tree, parent: [parent], author: AUTHOR, committer: AUTHOR } });
  await git.writeRef({ fs, dir, ref: REF, value: oid, force: true });
  return oid;
}

async function publishSource(transport: Transport, publisher: Publisher, gitClient: SourceGit, entry: SourceIndexEntry, fetchRaw: typeof fetch): Promise<PublishedSource> {
  const { tenantId } = publisher;
  const { fs } = gitClient;
  const asset = await ensureAsset(transport, tenantId, "workflow", entry.asset);
  // A deployment's permissions come from its asset's creator.
  if (asset.creatorPrincipalId !== publisher.principalId) throw new Error(`${entry.asset} was created by someone else; publishing to it would deploy under their permissions.`);
  const dir = `${gitClient.dir}/${entry.asset}`;
  await git.init({ fs, dir, defaultBranch: BRANCH });
  const tree = await writeTree(fs, dir, await (await portalPackage(fetchRaw, `sources/${entry.asset}.json`)).json() as SourceTree);
  const token = await gitToken(transport, tenantId, asset.id, entry.asset);
  try {
    const url = `${gitClient.origin}/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${encodeURIComponent(entry.asset)}.git`;
    const onAuth = () => ({ username: "git", password: token.secret });
    await git.addRemote({ fs, dir, remote: "origin", url, force: true });
    const { fetchHead } = await git.fetch({ fs, http: gitClient.http, dir, ref: BRANCH, singleBranch: true, tags: false, onAuth });
    if (!fetchHead) throw new Error(`${entry.asset} has no ${BRANCH} branch.`);
    const { commit } = await git.readCommit({ fs, dir, oid: fetchHead });
    if (commit.tree === tree) return { workflow: entry.workflow, assetId: asset.id, commitSha: fetchHead };
    // The hub starts every asset with one commit of its own; the release is the only commit on top of it.
    if (commit.parent.length > 0) throw new Error(`${entry.asset} already holds ${fetchHead}, not this release.`);
    const commitSha = await commitTree(fs, dir, tree, fetchHead, entry.asset);
    const result = await git.push({ fs, http: bandedPushAnswers(gitClient.http), dir, ref: BRANCH, onAuth });
    const pushed = result.refs[REF];
    if (!result.ok || !pushed?.ok) throw new Error(`Publishing ${entry.asset} failed: ${result.error ?? pushed?.error ?? "the hub did not accept the push"}.`);
    return { workflow: entry.workflow, assetId: asset.id, commitSha };
  } finally {
    await transport.fetch("DELETE", `/api/me/git-tokens/${encodeURIComponent(token.id)}`);
  }
}

/** Publishes the portal build's workflows one call at a time; a release already published keeps its commit. */
export async function publishSources(
  transport: Transport,
  publisher: Publisher,
  gitClient: SourceGit = browserGit(),
  fetchRaw: typeof fetch = fetch,
): Promise<PublishedSource[]> {
  const previous = publishing;
  let release = () => {};
  publishing = new Promise(function hold(resolve) { release = resolve; });
  try {
    await previous;
    const index = await (await portalPackage(fetchRaw, "sources/index.json")).json() as SourceIndexEntry[];
    const published: PublishedSource[] = [];
    for (const entry of index) published.push(await publishSource(transport, publisher, gitClient, entry, fetchRaw));
    return published;
  } finally {
    release();
  }
}
