// Publishes each release's workflows as source assets, one asset per workflow and release holding one commit, through
// Interchange's git smart-HTTP push.
import git, { type FsClient, type HttpClient, type TreeEntry } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createBrowserIsogitRuntime } from "@intx/storage-isogit/browser";
import type { Transport } from "@intx/hub-client";
import { DEPLOYER_GRANTS } from "@corbits/triage-contracts";
import { evaluateAccess } from "./hub-api.ts";
import { hubOrigin } from "./hub-origin.ts";
import { listModels, offeringsIn, type ModelInfo } from "./model-catalog.ts";
import { ensureAsset, portalPackage } from "./workflow-deploy.ts";
import { CHAIN_PACKAGES, type SourceIndexEntry, type SourceTree } from "./workflow-packages.ts";

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
      if (!request.url.endsWith("/git-receive-pack") || response.statusCode !== 200 || !response.body) return response;
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

// A failed revoke must not hide why the publish failed; the token expires on its own within minutes.
async function revoke(transport: Transport, tokenId: string): Promise<void> {
  try {
    await transport.fetch("DELETE", `/api/me/git-tokens/${encodeURIComponent(tokenId)}`);
  } catch (error) {
    console.warn(`Revoking git token ${tokenId} failed.`, error);
  }
}

/**
 * Stock gives an asset's creator no grant on it, so the publisher grants itself `write` on this one asset to push to it,
 * unless it already holds it, such as after an earlier publish whose push failed.
 */
async function grantOwnPush(transport: Transport, { tenantId, principalId }: Publisher, assetId: string): Promise<void> {
  const resource = `asset:${assetId}`;
  if (await evaluateAccess(transport, tenantId, principalId, resource, "write")) return;
  await transport.fetch("POST", `/api/tenants/${encodeURIComponent(tenantId)}/grants`, { principalId, resource, action: "write", effect: "allow", origin: "creator" });
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

async function hex8(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest.slice(0, 4), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A chain workflow's tree carries the release of the workflow it deploys, published before it, and its hash covers the
 * build and that release together, so the same build with other offerings publishes a new asset. When that
 * workflow was left out for a missing model, such as code review in a workspace without its model, the tree keeps the
 * build's empty release; any other gap is an ordering mistake and fails the publish.
 */
async function withRelease(models: readonly ModelInfo[], entry: SourceIndexEntry, tree: SourceTree, published: readonly PublishedSource[]): Promise<{ hash: string; tree: SourceTree }> {
  const plain = { hash: entry.hash, tree };
  const chain = CHAIN_PACKAGES.find((row) => row.name === entry.workflow);
  if (!chain || !("deploys" in chain)) return plain;
  const deployed = published.find((row) => row.workflow === chain.deploys.workflow);
  if (!deployed && !publishable(models, chain.deploys.workflow)) return plain;
  const target = CHAIN_PACKAGES.find((row) => row.name === chain.deploys.workflow);
  const offerings = target && offeringsIn(models, target.models);
  if (!deployed || !target || !offerings) throw new Error(`${entry.workflow} deploys ${chain.deploys.workflow}, which this release has not published before it.`);
  const file = `packages/${entry.workflow}/release.json`;
  if (!(file in tree)) throw new Error(`The portal build's ${entry.workflow} does not read a release.`);
  const release = { workflow: { assetId: deployed.assetId, commitSha: deployed.commitSha, packageName: target.packageName, entry: target.entry }, offerings };
  const json = `${JSON.stringify({ [chain.source]: { [chain.deploys.as]: release } }, null, 2)}\n`;
  return { hash: await hex8(`${entry.hash}\n${json}`), tree: { ...tree, [file]: json } };
}

/**
 * Each publisher's copy of a release is its own asset, since the asset's creator decides what its deployments may do;
 * asset names are lowercase kebab, so the principal id's `prn_` becomes `prn-`.
 */
function assetName(workflow: string, publisher: Publisher, hash: string): string {
  return `${workflow}-${publisher.principalId.replaceAll("_", "-")}-${hash}`;
}

/** A chain workflow publishes only while the workspace has every model it names; the others always publish. */
function publishable(models: readonly ModelInfo[], workflow: string): boolean {
  const chain = CHAIN_PACKAGES.find((row) => row.name === workflow);
  return !chain || offeringsIn(models, chain.models) !== undefined;
}

async function publishSource(transport: Transport, publisher: Publisher, gitClient: SourceGit, workflow: string, name: string, source: SourceTree): Promise<PublishedSource> {
  const { tenantId } = publisher;
  const { fs } = gitClient;
  const asset = await ensureAsset(transport, tenantId, "workflow", name);
  // A deployment's permissions come from its asset's creator.
  if (asset.creatorPrincipalId !== publisher.principalId) throw new Error(`${name} was created by someone else; publishing to it would deploy under their permissions.`);
  await grantOwnPush(transport, publisher, asset.id);
  const dir = `${gitClient.dir}/${name}`;
  await git.init({ fs, dir, defaultBranch: BRANCH });
  const tree = await writeTree(fs, dir, source);
  const token = await gitToken(transport, tenantId, asset.id, name);
  try {
    const url = `${gitClient.origin}/api/tenants/${encodeURIComponent(tenantId)}/assets/workflow/${encodeURIComponent(name)}.git`;
    const onAuth = () => ({ username: "git", password: token.secret });
    await git.addRemote({ fs, dir, remote: "origin", url, force: true });
    const { fetchHead } = await git.fetch({ fs, http: gitClient.http, dir, ref: BRANCH, singleBranch: true, tags: false, onAuth });
    if (!fetchHead) throw new Error(`${name} has no ${BRANCH} branch.`);
    const { commit } = await git.readCommit({ fs, dir, oid: fetchHead });
    if (commit.tree === tree) return { workflow, assetId: asset.id, commitSha: fetchHead };
    // The hub starts every asset with one commit of its own; the release is the only commit on top of it.
    if (commit.parent.length > 0) throw new Error(`${name} already holds ${fetchHead}, not this release.`);
    const commitSha = await commitTree(fs, dir, tree, fetchHead, name);
    await git.push({ fs, http: bandedPushAnswers(gitClient.http), dir, ref: BRANCH, onAuth });
    return { workflow, assetId: asset.id, commitSha };
  } finally {
    await revoke(transport, token.id);
  }
}

/** Each workflow published does what its publisher may, so publishing needs every grant the Deployer role holds. */
async function requireDeployer(transport: Transport, { tenantId, principalId }: Publisher): Promise<void> {
  const held = await Promise.all(DEPLOYER_GRANTS.map(({ resource, action }) => evaluateAccess(transport, tenantId, principalId, resource, action)));
  if (held.includes(false)) throw new Error("Only a Deployer can publish Triage's workflows. Ask a workspace owner to make you one under Settings, People.");
}

/**
 * Publishes the portal build's workflows one call at a time, in the build's order so each chain workflow follows the
 * one it deploys; a release already published keeps its commit, and a chain workflow whose models the workspace lacks
 * is left out.
 */
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
    await requireDeployer(transport, publisher);
    const index = await (await portalPackage(fetchRaw, "sources/index.json")).json() as SourceIndexEntry[];
    const models = await listModels(transport, publisher.tenantId);
    const published: PublishedSource[] = [];
    for (const entry of index.filter((row) => publishable(models, row.workflow))) {
      const built = await (await portalPackage(fetchRaw, `sources/${entry.workflow}-${entry.hash}.json`)).json() as SourceTree;
      const { hash, tree } = await withRelease(models, entry, built, published);
      published.push(await publishSource(transport, publisher, gitClient, entry.workflow, assetName(entry.workflow, publisher, hash), tree));
    }
    return published;
  } finally {
    release();
  }
}
