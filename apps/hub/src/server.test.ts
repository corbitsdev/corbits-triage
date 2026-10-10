// Requires PostgreSQL at TEST_DATABASE_URL.
import { afterEach, expect, test } from "bun:test";
import { type } from "arktype";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDB, schema } from "@intx/db";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import { doEffectId, type Branch, type ResolvedTarget } from "../../../packages/triage-workflows/src/logic/actions.js";
import { doMarker } from "../../../packages/triage-workflows/src/logic/execute-do.js";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/interchange";
// The hub shells out to `bunx`, which needs bun on PATH and a HOME for its cache.
const CHILD_PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
const processes: Bun.Subprocess[] = [];
const temporaryDirectories: string[] = [];

const TEST_SECRETS = {
  BETTER_AUTH_SECRET: "a".repeat(64),
  CREDENTIAL_ENCRYPTION_KEY: "b".repeat(64),
  PRINCIPAL_KEY_ENCRYPTION_KEY: "c".repeat(64),
  SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "d".repeat(64),
};

function emptyResponse(): Response {
  return new Response(null);
}

function reservePort(): number {
  const probe = Bun.serve({ port: 0, fetch: emptyResponse });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun did not assign a test server port");
  return port;
}

async function waitUntilReady(origin: string, child: Bun.Subprocess): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`${origin}/api/me`);
      if (response.status === 401) return true;
    } catch {
      // The server is still applying migrations or binding its socket.
    }
    await Bun.sleep(100);
  }
  return false;
}

function openWebSocket(url: string): Promise<void> {
  return new Promise(function upgrade(resolve, reject) {
    const socket = new WebSocket(url);
    const timeout = setTimeout(function onTimeout() {
      socket.close();
      reject(new Error(`Timed out upgrading ${url}`));
    }, 5_000);
    socket.addEventListener("open", function onOpen() {
      clearTimeout(timeout);
      socket.close();
      resolve();
    }, { once: true });
    socket.addEventListener("error", function onError() {
      clearTimeout(timeout);
      reject(new Error(`WebSocket upgrade failed for ${url}`));
    }, { once: true });
  });
}

afterEach(async () => {
  for (const child of processes.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(2_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "corbits-hub-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function startHub(extraEnv: Record<string, string> = {}, dataDir = temporaryDirectory()): Promise<string> {
  const port = reservePort();

  const child = Bun.spawn(
    [process.execPath, "--conditions=intx-src", "apps/hub/src/server.ts"],
    {
      cwd: ROOT,
      env: {
        PATH: CHILD_PATH,
        HOME: homedir(),
        ...TEST_SECRETS,
        DATABASE_URL: TEST_DATABASE_URL,
        HUB_DATA_DIR: dataDir,
        PORT: String(port),
        BETTER_AUTH_BASE_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  processes.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const origin = `http://127.0.0.1:${port}`;

  if (!(await waitUntilReady(origin, child))) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    throw new Error(`Composed hub did not become ready:\n${await stdout}\n${await stderr}`);
  }
  return origin;
}

/** JSON headers for a freshly signed-up member, sent from the hub's own origin. */
async function signedIn(origin: string): Promise<Record<string, string>> {
  const headers = { "content-type": "application/json", origin };
  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: `member-${crypto.randomUUID()}@example.com`, password: "password-123456", name: "Member" }),
  });
  expect(signUp.status).toBe(200);
  const cookie = signUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  return { ...headers, cookie };
}

async function createTenant(origin: string, headers: Record<string, string>): Promise<string> {
  const tenant = await fetch(`${origin}/api/tenants`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Acme", slug: `acme-${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(tenant.status).toBe(201);
  return type({ id: "string" }).assert(await tenant.json()).id;
}

async function createAsset(origin: string, headers: Record<string, string>, tenantId: string, kind: string): Promise<string> {
  const asset = await fetch(`${origin}/api/tenants/${tenantId}/assets`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind, name: `corbits-${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(asset.status).toBe(201);
  return type({ id: "string" }).assert(await asset.json()).id;
}

test("composed hub upgrades the sidecar websocket", async () => {
  const origin = await startHub();

  const response = await fetch(`${origin}/api/me`);
  expect(response.status).toBe(401);
  await expect(
    openWebSocket(`${origin.replace("http", "ws")}/api/sidecars/ws`),
  ).resolves.toBeUndefined();
}, 40_000);

test("composed hub documents the integration routes and still answers an invalid action with 400", async () => {
  const origin = await startHub();

  const { paths } = type({ paths: "Record<string, object>" }).assert(await (await fetch(`${origin}/openapi.json`)).json());
  expect(paths["/api/tenants"]).toBeDefined();
  const integrations = Object.entries(paths)
    .filter(([path]) => path.startsWith("/api/integrations/"))
    .map(([path, methods]) => [path, Object.keys(methods)]);
  expect(Object.fromEntries(integrations)).toEqual({
    "/api/integrations/auth-methods": ["get"],
    "/api/integrations/pack-schema": ["get"],
    "/api/integrations/github-manifest/{tenantId}/start": ["post"],
    "/api/integrations/github-manifest/{tenantId}/cancel": ["post"],
    "/api/integrations/github-manifest/callback": ["get"],
    "/api/integrations/github-installations/{tenantId}/sync": ["post"],
    "/api/integrations/github-actions/{tenantId}": ["post"],
    "/api/integrations/github-dos/{tenantId}": ["post", "get"],
    "/api/integrations/github-triage/{tenantId}": ["post"],
    "/api/integrations/github-open-pulls/{tenantId}": ["get"],
    "/api/integrations/github-pull/{tenantId}": ["get"],
    "/api/integrations/workflow-deploy/{tenantId}": ["post"],
    "/api/integrations/workflow-versions/{tenantId}": ["get"],
  });

  const headers = await signedIn(origin);
  const id = await createTenant(origin, headers);

  const action = await fetch(`${origin}/api/integrations/github-actions/${id}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repo: "acme/widgets", number: 0, action: "merge" }),
  });
  expect(action.status).toBe(400);
  expect(await action.json()).toMatchObject({ error: { code: "invalid_request" } });
}, 40_000);

test("workflow deploy refuses a package registry that is not the workspace's own or is not a registry", async () => {
  const origin = await startHub();
  const headers = await signedIn(origin);
  const id = await createTenant(origin, headers);
  const workflowAsset = await createAsset(origin, headers, id, "workflow");
  const otherRegistry = await createAsset(origin, headers, await createTenant(origin, headers), "package-registry");

  async function deploy(registryAssetId: string, pin = "@corbits/pr-triage-workflow@0.1.0") {
    const res = await fetch(`${origin}/api/integrations/workflow-deploy/${id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ registryAssetId, definitionAssetId: workflowAsset, pin, entry: "./pr-triage.mjs", sourceOfferingIds: ["mof_1"], defaultSourceOfferingId: "mof_1" }),
    });
    return { status: res.status, body: await res.json() };
  }
  expect(await deploy(otherRegistry)).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "Package registry asset not found" } } });
  expect(await deploy(workflowAsset)).toMatchObject({ status: 404, body: { error: { code: "not_found", message: "Package registry asset not found" } } });
  expect(await deploy(otherRegistry, "Not A Pin@")).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
}, 40_000);

const REPO = "acme/widgets";
const HEAD = "abc";
const APP_BOT = { login: "corbits[bot]", type: "Bot" };

/** GitHub holding open pull request 8 of REPO; a label named `boom` is refused with 422. */
function fakeGithub() {
  const labels: string[] = [];
  const comments: Array<{ id: number; user: typeof APP_BOT; body: string }> = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  async function github(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname === `/repos/${REPO}/installation`) return Response.json({ id: 1 });
    if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (pathname === `/repos/${REPO}/pulls/8`) return Response.json({ number: 8, state: "open", head: { sha: HEAD }, labels: labels.map((name) => ({ name })), assignees: [] });
    if (pathname === `/repos/${REPO}/issues/8/comments` && req.method === "GET") return Response.json(comments);
    if (req.method !== "POST") return new Response(null, { status: 404 });
    const body = type("Record<string, unknown>").assert(await req.json());
    if (pathname === `/repos/${REPO}/issues/8/labels`) {
      const names = type("string[]").assert(body["labels"]);
      if (names.includes("boom")) return new Response(null, { status: 422 });
      writes.push({ path: pathname, body });
      labels.push(...names);
      return Response.json(labels.map((name) => ({ name })));
    }
    if (pathname === `/repos/${REPO}/issues/8/comments`) {
      writes.push({ path: pathname, body });
      comments.push({ id: comments.length + 1, user: APP_BOT, body: String(body["body"]) });
      return Response.json(comments.at(-1));
    }
    return new Response(null, { status: 404 });
  }
  const server = Bun.serve({ port: 0, fetch: github });
  return { origin: `http://127.0.0.1:${server.port}`, comments, writes, stop: () => server.stop(true) };
}

type SeededDo = { id: string; kind: "labels" | "comment" | "agent"; target: ResolvedTarget; index?: number; effectId?: string };

const BRANCH: Branch = "always";

function effectOf(step: SeededDo, index: number, headSha = HEAD): string {
  return doEffectId({ repo: REPO, number: 8, headSha, actionId: step.id, branch: BRANCH, index, kind: step.kind, target: step.target });
}

/** A Do seeded without an index stands for a verdict written before Dos had one. */
function verdictStep(step: SeededDo, headSha: string) {
  const base = { id: step.id, branch: BRANCH, kind: step.kind, automatic: false, reason: "Always applies.", target: step.target };
  return step.index === undefined ? base : { ...base, index: step.index, effectId: step.effectId ?? effectOf(step, step.index, headSha) };
}

/** A completed run whose committed log holds a verdict for REPO#8, as the workflow writes it. */
async function seedRun(db: ReturnType<typeof createDB>["db"], dataDir: string, tenantId: string, dos: SeededDo[], headSha = HEAD): Promise<string> {
  const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const definitionId = `wfd_${suffix}`;
  const anchorRunId = `wfr_anchor${suffix}`;
  const runId = `wfr_${suffix}`;
  await db.insert(schema.workflowDefinition).values({ id: definitionId, tenantId, name: "seeded-pr-triage", status: "stopped" });
  await db.insert(schema.workflowRun).values({ id: anchorRunId, definitionId, anchorRunId, tenantId, status: "completed" });
  await db.insert(schema.workflowRun).values({ id: runId, definitionId, anchorRunId, tenantId, status: "completed" });

  const verdict = {
    repo: REPO, number: 8, headSha, workflowVersion: 1,
    request: { repo: REPO, number: 8, labels: [], owned: [], comment: "", close: false },
    actions: dos.map((step) => verdictStep(step, headSha)),
  };
  const events = [
    { type: "RunStarted", seq: 0, at: new Date().toISOString(), trigger: {} },
    { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } },
    { type: "RunCompleted", seq: 2 },
  ];
  const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, tenant!.domain));
  const dir = join(dataDir, "workflow-runs", repoId.id);
  const eventsDir = join(dir, "runs", runId, "events");
  mkdirSync(eventsDir, { recursive: true });
  for (const event of events) writeFileSync(join(eventsDir, `${event.seq}.json`), JSON.stringify(event));
  const git = ["git", "-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com"];
  await Bun.$`git init -q -b ${WORKFLOW_RUN_REF.replace("refs/heads/", "")} ${dir}`;
  await Bun.$`${git} add -A`;
  await Bun.$`${git} commit -q -m seed`;
  return runId;
}

test("a pack Do runs once by reference and is recorded", async () => {
  const github = fakeGithub();
  const dataDir = temporaryDirectory();
  const { db, close } = createDB({ host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" });
  try {
    const origin = await startHub({ GITHUB_API_ORIGIN: github.origin }, dataDir);
    const headers = await signedIn(origin);
    const tenantId = await createTenant(origin, headers);
    const otherTenantId = await createTenant(origin, headers);

    const provider = await fetch(`${origin}/api/tenants/${tenantId}/providers`, {
      method: "POST", headers, body: JSON.stringify({ name: "github", plugin: "http", apiBaseUrl: github.origin }),
    });
    expect(provider.status).toBe(201);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    const credential = await fetch(`${origin}/api/tenants/${tenantId}/credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: type({ id: "string" }).assert(await provider.json()).id, name: "github", type: "api_key", secret: JSON.stringify({ appId: "1", privateKey }) }),
    });
    expect(credential.status).toBe(201);
    const enable = await fetch(`${origin}/api/tenants/${tenantId}`, {
      method: "PATCH", headers, body: JSON.stringify({ config: { corbitsTriage: { rev: 0, repos: [{ name: REPO, connected: true, enabled: true }] } } }),
    });
    expect(enable.status).toBe(200);

    const runId = await seedRun(db, dataDir, tenantId, [
      { id: "label", kind: "labels", target: { labels: ["api"] }, index: 0 },
      { id: "note", kind: "comment", target: { body: "Thanks" }, index: 0 },
      { id: "posted", kind: "comment", target: { body: "Already said" }, index: 0 },
      { id: "agent", kind: "agent", target: { prompt: "Review", tools: [] }, index: 0 },
      { id: "old", kind: "labels", target: { labels: ["stale"] } },
      { id: "refused", kind: "labels", target: { labels: ["boom"] }, index: 0 },
      { id: "forged", kind: "labels", target: { labels: ["api"] }, index: 0, effectId: "0".repeat(64) },
    ]);
    const movedRunId = await seedRun(db, dataDir, tenantId, [{ id: "note", kind: "comment", target: { body: "Thanks" }, index: 0 }], "old");
    const otherRunId = await seedRun(db, dataDir, otherTenantId, [{ id: "label", kind: "labels", target: { labels: ["api"] }, index: 0 }]);
    github.comments.push({ id: 99, user: APP_BOT, body: `${doMarker(effectOf({ id: "posted", kind: "comment", target: { body: "Already said" } }, 0))}\nAlready said` });

    async function runDo(actionId: string, run = runId) {
      const res = await fetch(`${origin}/api/integrations/github-dos/${tenantId}`, {
        method: "POST", headers, body: JSON.stringify({ runId: run, repo: REPO, number: 8, actionId, branch: "always", index: 0 }),
      });
      return { status: res.status, body: await res.json() };
    }

    expect(await runDo("label")).toMatchObject({ status: 200, body: { kind: "labels", status: "done", replayed: false, attempts: 1, source: "portal" } });
    expect(await runDo("label")).toMatchObject({ status: 200, body: { status: "done", replayed: true } });
    expect(github.writes.filter((write) => write.path.endsWith("/labels"))).toEqual([{ path: `/repos/${REPO}/issues/8/labels`, body: { labels: ["api"] } }]);

    expect(await runDo("note")).toMatchObject({ status: 200, body: { kind: "comment", status: "done" } });
    expect(github.writes.at(-1)?.body["body"]).toBe(`${doMarker(effectOf({ id: "note", kind: "comment", target: { body: "Thanks" } }, 0))}\nThanks`);
    expect(await runDo("posted")).toMatchObject({ status: 200, body: { status: "satisfied", result: { commentId: 99 } } });

    expect(await runDo("label", otherRunId)).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(await runDo("agent")).toMatchObject({ status: 409, body: { error: { code: "do_not_runnable" } } });
    expect(await runDo("old")).toMatchObject({ status: 409, body: { error: { code: "verdict_outdated" } } });
    expect(await runDo("refused")).toMatchObject({ status: 502, body: { error: { code: "github_failed" } } });
    expect(await runDo("forged")).toMatchObject({ status: 409, body: { error: { code: "effect_mismatch" } } });
    expect(await runDo("note", movedRunId)).toMatchObject({ status: 409, body: { error: { code: "head_moved" } } });

    const listed = await fetch(`${origin}/api/integrations/github-dos/${tenantId}?repo=${REPO}&number=8`, { headers });
    expect(listed.status).toBe(200);
    const { dos } = type({ dos: type({ actionId: "string", status: "string" }).array() }).assert(await listed.json());
    expect(Object.fromEntries(dos.map((row) => [row.actionId, row.status]))).toEqual({ label: "done", note: "done", posted: "satisfied", refused: "failed" });
  } finally {
    github.stop();
    await close();
  }
}, 60_000);
