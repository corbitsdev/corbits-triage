import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "isomorphic-git/http/web";
import type { Transport } from "@intx/hub-client";
import { publishSources } from "./workflow-sources.ts";
import type { SourceTree } from "./workflow-packages.ts";

const SECRET = "itx_pat_test";
const PUBLISHER = { tenantId: "t", principalId: "prn_owner" };
const TREE: SourceTree = {
  "package.json": JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  "packages/pr-triage-github/package.json": JSON.stringify({ name: "@corbits/pr-triage-github-workflow", version: "0.1.0-sha-0123abcd", interchange: { workflow: "./pr-triage-github.mjs" } }),
  "packages/pr-triage-github/pr-triage-github.mjs": "export default {};\n",
};

const scratch = await mkdtemp(path.join(tmpdir(), "workflow-sources-"));
const repos = path.join(scratch, "hub");
const git = Bun.which("git");
if (!git) throw new Error("These tests need git.");
const gitPath = git;
const pushes: string[] = [];

// Stands in for the hub's smart-HTTP routes with git's own, behind the same URL and token check.
const server = Bun.serve({ port: 0, fetch: serveGit });
afterAll(async function cleanup() {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

async function serveGit(request: Request): Promise<Response> {
  if (request.headers.get("authorization") !== `Basic ${btoa(`git:${SECRET}`)}`) return new Response(null, { status: 401 });
  const url = new URL(request.url);
  const pathInfo = url.pathname.replace("/api/tenants/t/assets/workflow", "");
  if (pathInfo.endsWith("/git-receive-pack")) pushes.push(pathInfo);
  const backend = Bun.spawn([gitPath, "http-backend"], {
    env: { GIT_PROJECT_ROOT: repos, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "test", PATH_INFO: pathInfo, REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers.get("content-type") ?? "" },
    stdin: new Uint8Array(await request.arrayBuffer()),
    stdout: "pipe",
  });
  const output = Buffer.from(await new Response(backend.stdout).arrayBuffer());
  const split = output.indexOf("\r\n\r\n");
  const headers = new Headers();
  let status = 200;
  for (const line of output.subarray(0, split).toString().split("\r\n")) {
    const [name, value] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()];
    if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
    else headers.set(name, value);
  }
  const body = output.subarray(split + 4);
  return new Response(url.searchParams.get("service") === "git-receive-pack" ? withoutSideBand(body) : body, { status, headers });
}

// Like the hub, receive-pack offers no side-band, so a push is answered with bare report-status lines.
function withoutSideBand(advertisement: Buffer): Buffer {
  const lines: Buffer[] = [];
  let at = 0;
  while (at < advertisement.length) {
    const size = Number.parseInt(advertisement.subarray(at, at + 4).toString(), 16);
    if (size === 0) {
      lines.push(Buffer.from("0000"));
      at += 4;
      continue;
    }
    const payload = advertisement.subarray(at + 4, at + size).toString().replace(" side-band-64k", "");
    lines.push(Buffer.from(`${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`));
    at += size;
  }
  return Buffer.concat(lines);
}

// Without the runner's own git config, which may have no identity or may sign; the hub commits as itself.
const HUB_GIT = { GIT_AUTHOR_NAME: "Hub", GIT_AUTHOR_EMAIL: "hub@hub.test", GIT_COMMITTER_NAME: "Hub", GIT_COMMITTER_EMAIL: "hub@hub.test" };

function hubGit(args: string[], stdin?: string): string {
  const run = Bun.spawnSync([gitPath, ...args], { env: HUB_GIT, ...(stdin !== undefined && { stdin: Buffer.from(stdin) }) });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

// Like the hub, a new asset starts with one commit of its own holding a `.gitignore`.
function createRepo(name: string): void {
  const dir = path.join(repos, `${name}.git`);
  hubGit(["init", "--bare", "-q", "--initial-branch=main", dir]);
  const gitignore = hubGit(["--git-dir", dir, "hash-object", "-w", "--stdin"], "node_modules/\ndist/\n");
  const tree = hubGit(["--git-dir", dir, "mktree"], `100644 blob ${gitignore}\t.gitignore\n`);
  hubGit(["--git-dir", dir, "update-ref", "refs/heads/main", hubGit(["--git-dir", dir, "commit-tree", tree, "-m", "Initial commit"])]);
}

const OFFERINGS = { decision: ["mof_decision", "corbits-system-one"], "claude-opus-5-5": ["mof_opus", "anthropic"], "claude-haiku-5-5": ["mof_haiku", "anthropic"] };

function fakeHub(seeded: Array<{ name: string; creatorPrincipalId: string }> = [], offerings: Record<string, string[]> = OFFERINGS) {
  const assets = seeded.map((asset, n) => ({ id: `ast_seeded_${n}`, kind: "workflow", ...asset }));
  const requests: string[] = [];
  const tokens: unknown[] = [];
  async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
    requests.push(`${method} ${route}`);
    if (method === "GET" && route === "/api/tenants/t/assets?kind=workflow") return assets as T;
    if (method === "GET" && route === "/api/tenants/t/models") {
      return Object.entries(offerings).map(([canonicalName, [offeringId, providerName]]) => ({ canonicalName, offerings: [{ offeringId, providerName }] })) as T;
    }
    if (method === "POST" && route === "/api/tenants/t/assets") {
      const asset = { id: `ast_${assets.length + 1}`, creatorPrincipalId: PUBLISHER.principalId, ...(body as { kind: string; name: string }) };
      assets.push(asset);
      createRepo(asset.name);
      return asset as T;
    }
    if (method === "POST" && route === "/api/me/git-tokens") {
      tokens.push(body);
      return { id: `gtk_${tokens.length}`, secret: SECRET } as T;
    }
    if (method === "DELETE" && route.startsWith("/api/me/git-tokens/")) return undefined as T;
    throw new Error(`Unexpected ${method} ${route}`);
  }
  return { transport: { fetch: json } as unknown as Transport, requests, tokens };
}

/** The portal build's files: each workflow's tree under its build hash. */
function portalFiles(builds: Array<{ workflow: string; hash: string; tree: SourceTree }>): typeof fetch {
  async function serve(input: string | URL | Request): Promise<Response> {
    const file = String(input);
    if (file === "/packages/sources/index.json") return Response.json(builds.map(({ workflow, hash }) => ({ workflow, hash })));
    const build = builds.find(({ workflow, hash }) => file === `/packages/sources/${workflow}-${hash}.json`);
    return build ? Response.json(build.tree) : new Response(null, { status: 404 });
  }
  return serve as typeof fetch;
}

function gitIn(asset: string, ...args: string[]): string {
  return hubGit(["--git-dir", path.join(repos, `${asset}.git`), ...args]);
}

test("publishing a release twice pushes its commit once with a token scoped to the asset, then revokes it", async () => {
  const asset = "pr-triage-github-0123abcd";
  const hub = fakeHub();
  const gitClient = { fs, http, origin: server.url.origin, dir: path.join(scratch, "twice") };
  const files = portalFiles([{ workflow: "pr-triage-github", hash: "0123abcd", tree: TREE }]);
  const first = await publishSources(hub.transport, PUBLISHER, gitClient, files);
  const second = await publishSources(hub.transport, PUBLISHER, gitClient, files);

  expect(second).toEqual(first);
  expect(first).toEqual([{ workflow: "pr-triage-github", assetId: "ast_1", commitSha: gitIn(asset, "rev-parse", "refs/heads/main") }]);
  expect(gitIn(asset, "rev-list", "--count", "main")).toBe("2");
  expect(pushes).toEqual([`/${asset}.git/git-receive-pack`]);
  expect(hub.requests.filter((request) => request === "POST /api/tenants/t/assets")).toHaveLength(1);
  expect(gitIn(asset, "ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(Object.keys(TREE).sort());
  for (const token of hub.tokens) {
    expect(token).toEqual({ name: asset, resource: "asset:ast_1", refPattern: "refs/heads/main", actions: ["can_read", "can_push"], expiresAt: expect.any(String), tenantId: "t" });
  }
  expect(hub.requests.filter((request) => request.startsWith("DELETE /api/me/git-tokens/"))).toEqual(["DELETE /api/me/git-tokens/gtk_1", "DELETE /api/me/git-tokens/gtk_2"]);
});

test("refuses an asset another principal created, or whose main holds another commit", async () => {
  const asset = "pr-triage-github-4567cdef";
  createRepo(asset);
  const gitClient = { fs, http, origin: server.url.origin, dir: path.join(scratch, "refused") };
  const files = portalFiles([{ workflow: "pr-triage-github", hash: "4567cdef", tree: TREE }]);
  const foreign = fakeHub([{ name: asset, creatorPrincipalId: "prn_other" }]);
  await expect(publishSources(foreign.transport, PUBLISHER, gitClient, files)).rejects.toThrow("created by someone else");
  expect(foreign.tokens).toEqual([]);

  const other = gitIn(asset, "commit-tree", "main^{tree}", "-p", "main", "-m", "other");
  gitIn(asset, "update-ref", "refs/heads/main", other);
  const own = fakeHub([{ name: asset, creatorPrincipalId: PUBLISHER.principalId }]);
  await expect(publishSources(own.transport, PUBLISHER, gitClient, files)).rejects.toThrow(`already holds ${other}, not this release`);
});

function chainTree(workflow: string, release: boolean): SourceTree {
  return {
    "package.json": TREE["package.json"]!,
    [`packages/${workflow}/package.json`]: JSON.stringify({ name: `@corbits/${workflow}-workflow`, version: "0.1.0-sha-89abcdef", interchange: { workflow: `./${workflow}.mjs` } }),
    [`packages/${workflow}/${workflow}.mjs`]: "export default {};\n",
    ...(release && { [`packages/${workflow}/release.json`]: "{}\n" }),
  };
}

test("each chain workflow carries the release of the one it deploys, and its asset name changes with that release", async () => {
  const builds = [
    { workflow: "pr-code-review-reviewer-github", hash: "aaaaaaaa", tree: chainTree("pr-code-review-reviewer-github", false) },
    { workflow: "triage-manager-github", hash: "bbbbbbbb", tree: chainTree("triage-manager-github", true) },
    { workflow: "triage-listener-github", hash: "cccccccc", tree: chainTree("triage-listener-github", true) },
  ];
  const offerings = { ...OFFERINGS };
  const hub = fakeHub([], offerings);
  const gitClient = { fs, http, origin: server.url.origin, dir: path.join(scratch, "chain") };
  const [reviewer, manager, listener] = await publishSources(hub.transport, PUBLISHER, gitClient, portalFiles(builds));
  const assets = await hub.transport.fetch<Array<{ id: string; name: string }>>("GET", "/api/tenants/t/assets?kind=workflow");
  function nameOf(id: string): string {
    return assets.find((asset) => asset.id === id)!.name;
  }
  expect(nameOf(reviewer!.assetId)).toBe("pr-code-review-reviewer-github-aaaaaaaa");
  expect(nameOf(listener!.assetId)).toMatch(/^triage-listener-github-[0-9a-f]{8}$/);
  expect(nameOf(listener!.assetId)).not.toBe("triage-listener-github-cccccccc");
  function releaseOf(entry: { assetId: string }, workflow: string): unknown {
    return JSON.parse(gitIn(nameOf(entry.assetId), "show", `main:packages/${workflow}/release.json`));
  }
  expect(releaseOf(manager!, "triage-manager-github")).toEqual({
    github: { codeReview: { workflow: { assetId: reviewer!.assetId, commitSha: reviewer!.commitSha, packageName: "@corbits/pr-code-review-reviewer-github-workflow", entry: "./pr-code-review-reviewer-github.mjs" }, offerings: { ids: ["mof_opus", "mof_haiku"], defaultId: "mof_opus" } } },
  });
  expect(releaseOf(listener!, "triage-listener-github")).toEqual({
    github: { manager: { workflow: { assetId: manager!.assetId, commitSha: manager!.commitSha, packageName: "@corbits/triage-manager-github-workflow", entry: "./triage-manager-github.mjs" }, offerings: { ids: ["mof_decision"], defaultId: "mof_decision" } } },
  });

  offerings.decision = ["mof_decision_2", "corbits-system-one"];
  const [, managerAgain, listenerAgain] = await publishSources(hub.transport, PUBLISHER, gitClient, portalFiles(builds));
  const rekeyed = await hub.transport.fetch<Array<{ id: string; name: string }>>("GET", "/api/tenants/t/assets?kind=workflow");
  expect(managerAgain).toEqual(manager!);
  expect(rekeyed.find((asset) => asset.id === listenerAgain!.assetId)!.name).not.toBe(nameOf(listener!.assetId));
});
