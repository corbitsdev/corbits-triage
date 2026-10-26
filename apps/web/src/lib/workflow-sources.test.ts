import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "isomorphic-git/http/web";
import type { Transport } from "@intx/hub-client";
import { publishSources } from "./workflow-sources.ts";
import type { SourceIndexEntry, SourceTree } from "./workflow-packages.ts";

const SECRET = "itx_pat_test";
const PUBLISHER = { tenantId: "t", principalId: "prn_owner" };
const SOURCES: SourceIndexEntry[] = [{ workflow: "pr-triage-github", asset: "pr-triage-github-0123abcd" }];
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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

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

// Like the hub, a new asset starts with one commit of its own.
function createRepo(name: string): void {
  const dir = path.join(repos, `${name}.git`);
  Bun.spawnSync([gitPath, "init", "--bare", "-q", dir]);
  const seed = Bun.spawnSync([gitPath, "--git-dir", dir, "commit-tree", EMPTY_TREE, "-m", "Initial commit"]).stdout.toString().trim();
  Bun.spawnSync([gitPath, "--git-dir", dir, "update-ref", "refs/heads/main", seed]);
}

function fakeHub(seeded: Array<{ name: string; creatorPrincipalId: string }> = []) {
  const assets = seeded.map((asset, n) => ({ id: `ast_seeded_${n}`, kind: "workflow", ...asset }));
  const requests: string[] = [];
  const tokens: unknown[] = [];
  async function json<T>(method: string, route: string, body?: unknown): Promise<T> {
    requests.push(`${method} ${route}`);
    if (method === "GET" && route === "/api/tenants/t/assets?kind=workflow") return assets as T;
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

async function portalFiles(input: string | URL | Request): Promise<Response> {
  const file = String(input);
  if (file === "/packages/sources/index.json") return Response.json(SOURCES);
  if (file === `/packages/sources/${SOURCES[0]!.asset}.json`) return Response.json(TREE);
  return new Response(null, { status: 404 });
}

const ASSET = SOURCES[0]!.asset;
const bare = path.join(repos, `${ASSET}.git`);

function gitIn(...args: string[]): string {
  return Bun.spawnSync([gitPath, "--git-dir", bare, ...args]).stdout.toString().trim();
}

test("publishing a release twice pushes its commit once with a token scoped to the asset, then revokes it", async () => {
  const hub = fakeHub();
  const gitClient = { fs, http, origin: server.url.origin, dir: path.join(scratch, "twice") };
  const first = await publishSources(hub.transport, PUBLISHER, gitClient, portalFiles as typeof fetch);
  const second = await publishSources(hub.transport, PUBLISHER, gitClient, portalFiles as typeof fetch);

  expect(second).toEqual(first);
  expect(first).toEqual([{ workflow: "pr-triage-github", assetId: "ast_1", commitSha: gitIn("rev-parse", "refs/heads/main") }]);
  expect(gitIn("rev-list", "--count", "main")).toBe("2");
  expect(pushes).toEqual([`/${ASSET}.git/git-receive-pack`]);
  expect(hub.requests.filter((request) => request === "POST /api/tenants/t/assets")).toHaveLength(1);
  expect(gitIn("ls-tree", "-r", "--name-only", "main").split("\n")).toEqual(Object.keys(TREE).sort());
  for (const token of hub.tokens) {
    expect(token).toEqual({ name: ASSET, resource: "asset:ast_1", refPattern: "refs/heads/main", actions: ["can_read", "can_push"], expiresAt: expect.any(String), tenantId: "t" });
    expect(Date.parse((token as { expiresAt: string }).expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  }
  expect(hub.requests.filter((request) => request.startsWith("DELETE /api/me/git-tokens/"))).toEqual(["DELETE /api/me/git-tokens/gtk_1", "DELETE /api/me/git-tokens/gtk_2"]);
});

test("refuses an asset another principal created, or whose main holds another commit", async () => {
  const gitClient = { fs, http, origin: server.url.origin, dir: path.join(scratch, "refused") };
  const foreign = fakeHub([{ name: ASSET, creatorPrincipalId: "prn_other" }]);
  await expect(publishSources(foreign.transport, PUBLISHER, gitClient, portalFiles as typeof fetch)).rejects.toThrow("created by someone else");
  expect(foreign.tokens).toEqual([]);

  const other = gitIn("commit-tree", EMPTY_TREE, "-p", "main", "-m", "other");
  gitIn("update-ref", "refs/heads/main", other);
  const own = fakeHub([{ name: ASSET, creatorPrincipalId: PUBLISHER.principalId }]);
  await expect(publishSources(own.transport, PUBLISHER, gitClient, portalFiles as typeof fetch)).rejects.toThrow(`already holds ${other}, not this release`);
});
