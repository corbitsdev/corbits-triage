// Requires PostgreSQL at TEST_DB. Each run gets a database of its own, dropped after.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { type } from "arktype";
import { createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { count, eq, sql } from "drizzle-orm";
import { createDB, schema } from "@intx/db";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import { PreviewResponse } from "./github/pr-preview.js";
import { findArtifactByTitle, getArtifact } from "@corbits/artifacts";
import { checkPackName, emptyPack, parseTriageState, stockTriggerMail, triageStateName, TriageStats } from "@corbits/triage-contracts";
import type { ResolvedTarget, VerdictWord } from "@corbits/triage-contracts";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import { doEffectId } from "@corbits/triage-workflows/logic/actions";
import { workflow as prTriageWorkflow } from "@corbits/triage-workflows/pr-triage-github";
import { verdictRecord } from "./github/verdict-record-store.js";
import { ensureTriageRole } from "./github/automation.js";
import { patchCorbitsTriage, upsertConnectedRepos } from "./github/tenant-config.js";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const DATABASE = { ...TEST_DB, database: `corbits_server_${randomBytes(6).toString("hex")}` };
const TEST_DATABASE_URL = `postgres://postgres:postgres@localhost:5432/${DATABASE.database}`;
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

beforeAll(async () => {
  const admin = createDB(TEST_DB);
  try {
    await admin.db.execute(sql.raw(`create database ${DATABASE.database}`));
  } finally {
    await admin.close();
  }
});

afterAll(async () => {
  const admin = createDB(TEST_DB);
  try {
    await admin.db.execute(sql.raw(`drop database if exists ${DATABASE.database} with (force)`));
  } finally {
    await admin.close();
  }
});

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

async function collectLines(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let partial = "";
  for await (const chunk of stream) {
    const decoded = decoder.decode(chunk, { stream: true });
    text += decoded;
    const parts = (partial + decoded).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
  }
  return text;
}

async function startHub(extraEnv: Record<string, string> = {}, dataDir = temporaryDirectory(), output: string[] = []): Promise<string> {
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
  const stdout = collectLines(child.stdout, output);
  const stderr = new Response(child.stderr).text();
  const origin = `http://127.0.0.1:${port}`;

  if (!(await waitUntilReady(origin, child))) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    throw new Error(`Composed hub did not become ready:\n${await stdout}\n${await stderr}`);
  }
  return origin;
}

let memberCount = 0;

async function verify(email: string): Promise<void> {
  const { db, close } = createDB(DATABASE);
  try {
    await db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.email, email));
  } finally {
    await close();
  }
}

/** Verified unless asked otherwise, as every hub route outside sign-in needs. */
async function signedIn(origin: string, email = `member-${crypto.randomUUID()}@example.com`, verified = true): Promise<Record<string, string>> {
  const headers = { "content-type": "application/json", origin };
  // Each member signs up from its own address so sign-up rate limits apply per member.
  memberCount += 1;
  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { ...headers, "x-forwarded-for": `198.51.100.${memberCount}` },
    body: JSON.stringify({ email, password: "password-123456", name: "Member" }),
  });
  expect(signUp.status).toBe(200);
  if (verified) await verify(email);
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

test("repeated sign-in attempts from one client are rate limited", async () => {
  const origin = await startHub();

  async function signIn(clientIp: string) {
    const response = await fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-forwarded-for": clientIp },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    });
    return response.status;
  }

  const statuses = [];
  for (let attempt = 0; attempt < 4; attempt++) statuses.push(await signIn("203.0.113.1"));
  expect(statuses).toEqual([401, 401, 401, 429]);
  expect(await signIn("203.0.113.2")).toBe(401);
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
    "/api/integrations/policy/validate": ["post"],
    "/api/integrations/github-manifest/{tenantId}/start": ["post"],
    "/api/integrations/github-manifest/callback": ["get"],
    "/api/integrations/github-installations/{tenantId}/sync": ["post"],
    "/api/integrations/github-actions/{tenantId}": ["post"],
    "/api/integrations/github-held-dos/{tenantId}": ["post"],
    "/api/integrations/github-triage/{tenantId}": ["post"],
    "/api/integrations/github-triage/{tenantId}/policy": ["get"],
    "/api/integrations/github-triage/{tenantId}/policy/file": ["get"],
    "/api/integrations/github-triage/{tenantId}/policy/export": ["post"],
    "/api/integrations/github-triage/{tenantId}/policy/upgrades": ["get"],
    "/api/integrations/github-triage/{tenantId}/backlog": ["post"],
    "/api/integrations/github-open-pulls/{tenantId}": ["get"],
    "/api/integrations/github-pull/{tenantId}": ["get"],
    "/api/integrations/merge-states/{tenantId}": ["get"],
    "/api/integrations/github-preview/{tenantId}": ["post"],
    "/api/integrations/triage-queue/{tenantId}": ["get"],
    "/api/integrations/triage-stats/{tenantId}": ["get"],
    "/api/integrations/triage-timeline/{tenantId}": ["get"],
    "/api/integrations/triage-verdicts/{tenantId}": ["get"],
    "/api/integrations/audit/{tenantId}": ["get"],
    "/api/integrations/workflow-deploy/{tenantId}": ["post"],
    "/api/integrations/workflow-versions/{tenantId}": ["get"],
    "/api/integrations/code-review/{tenantId}": ["post", "get"],
    "/api/integrations/code-review/{tenantId}/place": ["get"],
    "/api/integrations/code-review/{tenantId}/run": ["post"],
    "/api/integrations/invitations/{tenantId}": ["post", "get"],
    "/api/integrations/invitations/{tenantId}/{principalId}/resend": ["post"],
    "/api/integrations/invitations/{tenantId}/{principalId}": ["delete"],
    "/api/integrations/invitations/{tenantId}/{principalId}/verify": ["post"],
    "/api/integrations/invite-accept": ["post"],
    "/api/integrations/sessions": ["get"],
    "/api/integrations/sessions/{sessionId}": ["delete"],
    "/api/integrations/bitbucket-datacenter/{tenantId}/connection": ["put", "get", "delete"],
    "/api/integrations/bitbucket-datacenter/{tenantId}/repositories": ["get"],
    "/api/integrations/bitbucket-datacenter/{tenantId}/repositories/{project}/{slug}/enable": ["post"],
    "/api/integrations/bitbucket-datacenter/{tenantId}/repositories/{project}/{slug}/webhook": ["get"],
    "/api/integrations/bitbucket-datacenter/{tenantId}/repositories/{project}/{slug}/disable": ["post"],
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

function fakeGithub() {
  const labels: string[] = [];
  const comments: Array<{ id: number; user: typeof APP_BOT; body: string }> = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const repoRequests: string[] = [];
  const reads: Record<string, unknown> = {
    [`/repos/${REPO}/pulls`]: [{ number: 8, title: "Fix the widget", draft: false, head: { sha: HEAD } }],
    [`/repos/${REPO}/pulls/9`]: { number: 9, state: "closed", head: { sha: "def" } },
    [`/repos/${REPO}/pulls/8/reviews`]: [],
    [`/repos/${REPO}/pulls/8/commits`]: [{ sha: HEAD, commit: { message: "fix: the widget" } }],
    [`/repos/${REPO}/pulls/8/files`]: [{ filename: "src/widget.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1 @@\n+fixed" }],
    [`/repos/${REPO}/commits/${HEAD}/check-runs`]: { check_runs: [{ name: "build", status: "completed", conclusion: "success" }] },
  };
  async function github(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/repos/")) repoRequests.push(`${req.method} ${pathname}`);
    if (pathname === `/repos/${REPO}/installation`) return Response.json({ id: 1 });
    if (pathname === "/app/installations/1/access_tokens") return Response.json({ token: "installation-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (pathname === `/repos/${REPO}/pulls/8`) {
      return Response.json({
        number: 8, title: "Fix the widget", state: "open", user: { login: "octocat" }, head: { sha: HEAD, ref: "fix-widget" }, mergeable: true,
        changed_files: 1, additions: 1, deletions: 0, labels: labels.map((name) => ({ name })), assignees: [],
      });
    }
    if (pathname === `/repos/${REPO}/issues/8/comments` && req.method === "GET") return Response.json(comments);
    if (req.method === "GET" && pathname in reads) return Response.json(reads[pathname]);
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
  return { origin: `http://127.0.0.1:${server.port}`, comments, writes, repoRequests, stop: () => server.stop(true) };
}

async function connectGithub(db: Db, origin: string, headers: Record<string, string>, tenantId: string, githubOrigin: string): Promise<string> {
  const provider = await fetch(`${origin}/api/tenants/${tenantId}/providers`, {
    method: "POST", headers, body: JSON.stringify({ name: "github", plugin: "http", apiBaseUrl: githubOrigin }),
  });
  expect(provider.status).toBe(201);
  const providerId = type({ id: "string" }).assert(await provider.json()).id;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const credential = await fetch(`${origin}/api/tenants/${tenantId}/credentials`, {
    method: "POST",
    headers,
    body: JSON.stringify({ providerId, name: "github", type: "api_key", secret: JSON.stringify({ appId: "1", privateKey }), metadata: { appSlug: "corbits" } }),
  });
  expect(credential.status).toBe(201);
  const installed = await patchCorbitsTriage(db, tenantId, function install(ns) {
    return upsertConnectedRepos(ns, [REPO], { installationId: 1 });
  });
  const enable = await fetch(`${origin}/api/tenants/${tenantId}`, {
    method: "PATCH", headers, body: JSON.stringify({ config: { corbitsTriage: { rev: installed?.rev, repos: [{ name: REPO, enabled: true }] } } }),
  });
  expect(enable.status).toBe(200);
  return providerId;
}

type SeededDo = { list: VerdictWord; kind: "labels" | "comment"; target: ResolvedTarget; index?: number; effectId?: string; held?: true };

function effectOf(step: SeededDo, index: number, headSha = HEAD): string {
  return doEffectId({ repo: REPO, number: 8, headSha, list: step.list, index, kind: step.kind, target: step.target });
}

/** A Do seeded without an index stands for a verdict written before Dos had one. */
function verdictStep(step: SeededDo, headSha: string) {
  const base = { list: step.list, kind: step.kind, reason: "passes the repository's policy", target: step.target };
  return step.index === undefined ? base : { ...base, index: step.index, effectId: step.effectId ?? effectOf(step, step.index, headSha), ...(step.held && { held: true }) };
}

type Db = ReturnType<typeof createDB>["db"];
type SeededEvent = { type: string; seq: number } & Record<string, unknown>;

async function seedDeployment(db: Db, dataDir: string, tenantId: string, runs: SeededEvent[][], workflow = "seeded-pr-triage"): Promise<string[]> {
  const tenant = await db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const definitionId = `wfd_${suffix}`;
  const anchorRunId = `wfr_anchor${suffix}`;
  const live = workflow !== "seeded-pr-triage";
  await db.insert(schema.workflowDefinition).values({ id: definitionId, tenantId, name: workflow, status: "stopped" });
  await db.insert(schema.workflowRun).values({ id: anchorRunId, definitionId, anchorRunId, tenantId, status: live ? "deployed" : "completed" });
  const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, tenant!.domain));
  const dir = join(dataDir, "workflow-runs", repoId.id);
  const runIds: string[] = [];
  for (const [i, events] of runs.entries()) {
    const runId = `wfr_${suffix}${i}`;
    await db.insert(schema.workflowRun).values({ id: runId, definitionId, anchorRunId, tenantId, status: "completed" });
    const eventsDir = join(dir, "runs", runId, "events");
    mkdirSync(eventsDir, { recursive: true });
    for (const event of events) writeFileSync(join(eventsDir, `${event.seq}.json`), JSON.stringify(event));
    runIds.push(runId);
  }
  const git = ["git", "-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.com"];
  await Bun.$`git init -q -b ${WORKFLOW_RUN_REF.replace("refs/heads/", "")} ${dir}`;
  await Bun.$`${git} add -A`;
  await Bun.$`${git} commit -q -m seed`;
  return runIds;
}

async function seedRun(db: Db, dataDir: string, tenantId: string, dos: SeededDo[], headSha = HEAD): Promise<string> {
  const verdict = {
    repo: REPO, number: 8, headSha,
    request: { repo: REPO, number: 8, labels: [], owned: [], comment: "" },
    actions: dos.map((step) => verdictStep(step, headSha)),
  };
  const [runId] = await seedDeployment(db, dataDir, tenantId, [[
    { type: "RunStarted", seq: 0, at: new Date().toISOString(), trigger: {} },
    { type: "StepCompleted", seq: 1, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } },
    { type: "RunCompleted", seq: 2 },
  ]]);
  return runId!;
}

test("a held Do is approved only as its own workspace's verdict recorded it, and only to a running pr-triage", async () => {
  const github = fakeGithub();
  const dataDir = temporaryDirectory();
  const { db, close } = createDB(DATABASE);
  try {
    const origin = await startHub({ GITHUB_API_ORIGIN: github.origin }, dataDir);
    const headers = await signedIn(origin);
    const tenantId = await createTenant(origin, headers);
    const otherTenantId = await createTenant(origin, headers);

    await connectGithub(db, origin, headers, tenantId, github.origin);

    const label: SeededDo = { list: "pass", kind: "labels", target: { labels: ["api"] }, index: 0, held: true };
    const forged: SeededDo = { list: "fail", kind: "labels", target: { labels: ["api"] }, index: 0, effectId: "0".repeat(64), held: true };
    const runId = await seedRun(db, dataDir, tenantId, [label, forged]);
    const otherRunId = await seedRun(db, dataDir, otherTenantId, [label]);

    async function approve(effectId: string, run = runId) {
      const res = await fetch(`${origin}/api/integrations/github-held-dos/${tenantId}`, {
        method: "POST", headers, body: JSON.stringify({ runId: run, repo: REPO, number: 8, effectId, kind: "labels" }),
      });
      return { status: res.status, body: await res.json() };
    }

    expect(await approve(effectOf(label, 0))).toMatchObject({ status: 503, body: { error: { code: "service_not_running" } } });
    expect(await approve("0".repeat(64))).toMatchObject({ status: 409, body: { error: { code: "effect_mismatch" } } });
    expect(await approve("1".repeat(64))).toMatchObject({ status: 404, body: { error: { code: "do_not_found" } } });
    expect(await approve(effectOf(label, 0), otherRunId)).toMatchObject({ status: 404, body: { error: { code: "run_not_found" } } });
    expect(github.writes).toEqual([]);
  } finally {
    github.stop();
    await close();
  }
}, 60_000);

function say(body: string) {
  return [{ do: "comment", target: { body } }];
}

const SAVED_PACK = {
  ...emptyPack(REPO),
  checks: { "ci-green": { enabled: true } },
  actions: { when: ["opened", "updated", "checks", "ready"], pass: [{ do: "labels", target: { from: "list", labels: ["checked"] } }], fail: [], unsure: [] },
};

const JUDGED_PACK = {
  ...emptyPack(REPO),
  checks: { "max-files-changed": { enabled: true, maxFiles: 0 } },
  custom: [{ id: "custom-1", name: "Explains why", group: "pull-request", kind: "model", shape: "is-true", claim: "The description says why." }],
  actions: { when: ["opened", "updated", "checks", "ready"], pass: say("pass"), fail: say("fail"), unsure: say("unsure") },
};

test("a pack preview evaluates an open pull request without writing anything", async () => {
  const github = fakeGithub();
  const { db, close } = createDB(DATABASE);
  try {
    const origin = await startHub({ GITHUB_API_ORIGIN: github.origin });
    const headers = await signedIn(origin);
    const tenantId = await createTenant(origin, headers);
    await connectGithub(db, origin, headers, tenantId, github.origin);
    const title = checkPackName(REPO);
    const saved = await fetch(`${origin}/api/tenants/${tenantId}/artifacts`, {
      method: "POST", headers, body: JSON.stringify({ mode: "text", title, content: JSON.stringify(SAVED_PACK), metadata: { checkPack: title } }),
    });
    expect(saved.status).toBe(201);

    async function preview(body: Record<string, unknown>, as: Record<string, string> = headers) {
      const res = await fetch(`${origin}/api/integrations/github-preview/${tenantId}`, { method: "POST", headers: as, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    }

    async function previewed(body: Record<string, unknown>) {
      const res = await preview(body);
      expect(res.status).toBe(200);
      return PreviewResponse.assert(res.body);
    }

    const stored = await previewed({ repo: REPO, number: 8 });
    const reason = "every rule passed, and the policy has no decision-model rule";
    expect(stored).toMatchObject({ repo: REPO, number: 8, headSha: HEAD, event: "catch-up", pack: "saved", judge: "not-needed", verdict: { verdict: "pass", reason, degraded: null } });
    expect(stored.checks).toContainEqual({ check: "ci-green", name: "CI green", kind: "machine", result: "pass", reason: "required checks are passing", evidence: [], output: { kind: "values", values: { status: "passing" } } });
    expect(stored.verdict).not.toHaveProperty("request");
    const target = { labels: ["checked"] };
    const effectId = doEffectId({ repo: REPO, number: 8, headSha: HEAD, list: "pass", index: 0, kind: "labels", target });
    expect(stored.actions).toEqual({ status: "decided", verdict: "pass", dos: [{ list: "pass", index: 0, kind: "labels", reason, target, effectId, held: true }] });

    const sized = await previewed({ repo: REPO, number: 8, pack: JUDGED_PACK });
    expect(sized).toMatchObject({ pack: "candidate", judge: "not-needed", verdict: { verdict: "fail", state: "needs-author-update", degraded: null, score: null } });
    expect(sized.checks).toContainEqual({ check: "custom-1", name: "Explains why", kind: "model", result: "unconfirmed", reason: "not asked", evidence: [], output: { kind: "could-not-check", reason: "not asked" } });
    expect(sized.actions).toMatchObject({ status: "decided", verdict: "fail", dos: [{ list: "fail", target: { body: "fail" }, held: true }] });
    const judged = await previewed({ repo: REPO, number: 8, pack: { ...JUDGED_PACK, checks: {} } });
    expect(judged).toMatchObject({ judge: "not-run", verdict: { verdict: "unsure", state: "awaiting-review", reason: "needs the judge", humanGated: false, degraded: null } });
    expect(judged.checks).toContainEqual({ check: "custom-1", name: "Explains why", kind: "model", result: "needs-judge", reason: "needs the judge", evidence: [], output: { kind: "could-not-check", reason: "needs the judge" } });
    if (judged.actions.status !== "waits-on-judge") throw new Error("a judged pack must wait on the judge");
    expect(judged.actions.lists.map((list) => [list.verdict, list.dos.map((d) => d.target)])).toEqual([
      ["pass", [{ body: "pass" }]],
      ["fail", [{ body: "fail" }]],
      ["unsure", [{ body: "unsure" }]],
    ]);

    expect(github.repoRequests.filter((request) => !request.startsWith("GET "))).toEqual([]);
    expect(await findArtifactByTitle(db, tenantId, triageStateName(REPO))).toBeNull();

    expect(await preview({ repo: REPO, number: 9 })).toMatchObject({ status: 409, body: { error: { code: "pull_request_not_open" } } });
    expect(await preview({ repo: REPO, number: 7 })).toMatchObject({ status: 404, body: { error: { code: "pull_request_not_found" } } });
    expect(await preview({ repo: REPO, number: 8, pack: emptyPack("acme/gadgets") })).toMatchObject({ status: 400, body: { error: { code: "invalid_pack" } } });
    expect(await preview({ repo: REPO, number: 8 }, { ...headers, origin: "https://elsewhere.example" })).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    const { cookie: _cookie, ...signedOut } = headers;
    expect(await preview({ repo: REPO, number: 8 }, signedOut)).toMatchObject({ status: 401, body: { error: { code: "unauthorized" } } });
    expect(await preview({ repo: REPO, number: 8 }, await signedIn(origin))).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
  } finally {
    github.stop();
    await close();
  }
}, 60_000);

function timedRun(started: Date, tookMs: number, verdict: Record<string, unknown>, mirrored = false): SeededEvent[] {
  const at = (offsetMs: number) => new Date(started.getTime() + offsetMs).toISOString();
  const number = Number(verdict["number"]);
  const payload = stockTriggerMail({ kind: "pr", repo: REPO, prNumber: number, headSha: verdict["headSha"] });
  const mirror = mirrored ? { call: `mirror:${REPO.replace("/", "--")}:${number}`, ok: true } : { skipped: true };
  return [
    { type: "RunStarted", seq: 0, at: at(0), trigger: { type: "mail", payload } },
    { type: "StepCompleted", seq: 1, at: at(tookMs), stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } },
    { type: "StepCompleted", seq: 2, at: at(tookMs + 1_000), stepId: "mirror", output: { ref: `inline:${JSON.stringify({ reply: JSON.stringify(mirror) })}` } },
    { type: "RunCompleted", seq: 3, at: at(tookMs + 2_000) },
  ];
}

function statsVerdict(number: number, headSha: string, fields: Record<string, unknown>) {
  return {
    repo: REPO, number, headSha, state: "ready-monitoring", actor: "author", humanGated: false, degraded: null, checks: [], actions: [],
    request: { repo: REPO, number, labels: [], owned: [], comment: "" },
    ...fields,
  };
}

test("triage stats count a repository's recorded verdicts and Dos", async () => {
  const github = fakeGithub();
  const dataDir = temporaryDirectory();
  const { db, close } = createDB(DATABASE);
  try {
    const origin = await startHub({ GITHUB_API_ORIGIN: github.origin, TRIAGE_RECONCILE_INTERVAL_MS: "200" }, dataDir);
    const headers = await signedIn(origin);
    const tenantId = await createTenant(origin, headers);
    const otherTenantId = await createTenant(origin, headers);
    await connectGithub(db, origin, headers, tenantId, github.origin);

    const label: SeededDo = { list: "pass", kind: "labels", target: { labels: ["api"] }, index: 0 };
    const note: SeededDo = { list: "fail", kind: "comment", target: { body: "Thanks" }, index: 0 };
    const ci = (result: string, check = "ci-green") => ({ check, kind: "machine", result, reason: "", evidence: [] });
    // Noon UTC yesterday keeps the runs on one UTC day at any hour.
    const started = new Date(new Date().setUTCHours(-12, 0, 0, 0));
    await seedDeployment(db, dataDir, tenantId, [
      timedRun(started, 60_000, statsVerdict(7, "sha7", { checks: [ci("pass", "ci")], request: { repo: REPO, number: 7, labels: [], owned: [], comment: "Looks good" } }), true),
      timedRun(new Date(started.getTime() + 600_000), 180_000, statsVerdict(8, HEAD, {
        state: "awaiting-review", actor: "maintainer", checks: [ci("unconfirmed")], actions: [{ ...verdictStep(label, HEAD), status: "done" }, verdictStep(note, HEAD)],
      })),
      timedRun(new Date(started.getTime() + 1_200_000), 900_000, statsVerdict(8, HEAD, { state: "stale-unknown", actor: "system", degraded: "error", checks: [ci("fail")] })),
    ], prTriageWorkflow.id);

    // Answers are cached for a minute, so the route is asked only once the reconciler recorded every verdict.
    const deadline = Date.now() + 20_000;
    let recorded = 0;
    while (recorded < 3 && Date.now() < deadline) {
      await Bun.sleep(200);
      const [row] = await db.select({ rows: count() }).from(verdictRecord).where(eq(verdictRecord.tenantId, tenantId));
      recorded = row?.rows ?? 0;
    }
    expect(recorded).toBe(3);

    async function stats(tenant: string) {
      const res = await fetch(`${origin}/api/integrations/triage-stats/${tenant}?repo=${REPO}`, { headers });
      expect(res.status).toBe(200);
      return TriageStats.assert(await res.json());
    }
    const verdictAt = new Date(started.getTime() + 60_000);
    const body = await stats(tenantId);
    expect(body).toMatchObject({
      repo: REPO,
      days: 7,
      since: verdictAt.toISOString(),
      triaged: 2,
      verdicts: { "ready-monitoring": 1, "awaiting-review": 1 },
      neededYou: 1,
      checks: { "ci-green": { pass: 1, fail: 0, unconfirmed: 1 } },
      actions: { pass: { suggested: 1, executed: 1, failed: 0 }, fail: { suggested: 1, executed: 0, failed: 0 } },
      comments: 1,
    });
    expect(body.daily).toHaveLength(7);
    expect(body.daily.filter((d) => d.triaged > 0)).toEqual([{ date: verdictAt.toISOString().slice(0, 10), triaged: 2 }]);

    expect(await stats(otherTenantId)).toMatchObject({ since: null, triaged: 0, verdicts: {}, checks: {}, actions: {}, comments: 0 });
  } finally {
    github.stop();
    await close();
  }
}, 60_000);

const HOOK_SECRET = "hook-secret";

test("a burst of webhook deliveries for one pull request queues its head once and mails it once", async () => {
  const github = fakeGithub();
  const output: string[] = [];
  const { db, close } = createDB(DATABASE);
  try {
    const origin = await startHub({ GITHUB_API_ORIGIN: github.origin, TRIAGE_COALESCE_QUIET_MS: "1000" }, temporaryDirectory(), output);
    const headers = await signedIn(origin);
    const tenantId = await createTenant(origin, headers);
    const providerId = await connectGithub(db, origin, headers, tenantId, github.origin);
    const title = checkPackName(REPO);
    const saved = await fetch(`${origin}/api/tenants/${tenantId}/artifacts`, {
      method: "POST", headers, body: JSON.stringify({ mode: "text", title, content: JSON.stringify(SAVED_PACK), metadata: { checkPack: title } }),
    });
    expect(saved.status).toBe(201);
    const hook = await fetch(`${origin}/api/tenants/${tenantId}/credentials`, {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId, name: "github-hook", type: "api_key", secret: HOOK_SECRET, metadata: xHubHookMetadata(prTriageWorkflow.id, GITHUB_HOOK_HEADERS) }),
    });
    expect(hook.status).toBe(201);
    const hookId = type({ id: "string" }).assert(await hook.json()).id;

    const repository = { full_name: REPO };
    const pull = { number: 8, state: "open", draft: false, head: { sha: HEAD }, user: { login: "octocat" }, title: "Fix the widget", body: "" };
    const checkRun = { action: "completed", repository, check_run: { head_sha: HEAD, pull_requests: [{ number: 8, head: { sha: HEAD } }] } };
    const deliveries: Array<[string, unknown]> = [
      ["pull_request", { action: "opened", repository, pull_request: pull }],
      ["pull_request", { action: "edited", repository, pull_request: pull }],
      ["check_run", checkRun],
      ["check_run", checkRun],
      ["pull_request_review", { action: "submitted", repository, pull_request: pull, review: { state: "approved" } }],
      ["issue_comment", { action: "created", repository, issue: { number: 8, state: "open", pull_request: {}, user: { login: "octocat" } }, comment: { body: "Looks good" } }],
    ];
    const statuses = [];
    for (const [event, payload] of deliveries) {
      const body = JSON.stringify(payload);
      const res = await fetch(`${origin}/api/hooks/${hookId}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": event,
          "x-github-delivery": crypto.randomUUID(),
          "x-hub-signature-256": `sha256=${createHmac("sha256", HOOK_SECRET).update(body).digest("hex")}`,
        },
        body,
      });
      expect(res.status).toBe(202);
      statuses.push(type({ status: "string" }).assert(await res.json()).status);
    }
    expect(statuses).toEqual(["queued", "coalesced", "coalesced", "coalesced", "coalesced", "coalesced"]);

    const state = await findArtifactByTitle(db, tenantId, triageStateName(REPO));
    const stored = parseTriageState((await getArtifact(db, state!.artifactId))!.content, REPO);
    expect(stored?.prs).toEqual([expect.objectContaining({ number: 8, headSha: HEAD, status: "queued" })]);

    function flushes() {
      return output.flatMap((line) => {
        const entry = line.startsWith("{\"ts\":") ? JSON.parse(line) : undefined;
        return entry?.pr === 8 && ["forwarded", "forward_failed"].includes(entry.msg) ? [entry] : [];
      });
    }
    // The window holds at most four quiet periods; wait past it so a second mail would show.
    await Bun.sleep(5_000);
    expect(flushes().length).toBeGreaterThanOrEqual(1);
    expect(flushes().length).toBeLessThanOrEqual(2);
    expect(flushes()[0]).toMatchObject({ headSha: HEAD, events: ["opened", "updated", "checks", "approved", "commented"] });
  } finally {
    github.stop();
    await close();
  }
}, 60_000);

function smtpSink() {
  const messages: string[] = [];
  const server = Bun.listen<{ pending: string; message: string[] | undefined }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.data = { pending: "", message: undefined };
        socket.write("220 sink\r\n");
      },
      data(socket, chunk) {
        const lines = (socket.data.pending + chunk.toString()).split("\r\n");
        socket.data.pending = lines.pop() ?? "";
        for (const line of lines) {
          const { message } = socket.data;
          if (message !== undefined && line !== ".") message.push(line.replace(/^\./, ""));
          else if (message !== undefined) {
            messages.push(message.join("\n"));
            socket.data.message = undefined;
            socket.write("250 queued\r\n");
          } else if (line.startsWith("RCPT TO:<bounce")) socket.write("550 no such user\r\n");
          else if (line === "DATA") {
            socket.data.message = [];
            socket.write("354 go ahead\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 ok\r\n");
        }
      },
    },
  });
  function parse(message: string) {
    const [head = "", ...body] = message.split("\n\n");
    const headers = Object.fromEntries(head.replace(/\n\s+/g, " ").split("\n").map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const text = body.join("\n\n").replace(/=\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return { headers, text };
  }
  return { url: `smtp://127.0.0.1:${server.port}`, sent: () => messages.map(parse), stop: () => server.stop(true) };
}

test("an invite joins only its verified invitee, by an emailed magic link or a copied link that signs nobody in", async () => {
  const smtp = smtpSink();
  const portal = "http://portal.test";
  const output: string[] = [];
  const origin = await startHub({ PORTAL_ORIGIN: portal, SMTP_URL: smtp.url, EMAIL_FROM: "Triage <triage@example.com>" }, temporaryDirectory(), output);
  const noEmailOutput: string[] = [];
  const noEmail = await startHub({ PORTAL_ORIGIN: portal }, temporaryDirectory(), noEmailOutput);
  const emailOf = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const [boss, ann, bob, cat, dee, eve, fay, gil, bounce] = ["boss", "ann", "bob", "cat", "dee", "eve", "fay", "gil", "bounce"].map(emailOf) as [string, string, string, string, string, string, string, string, string];
  const owner = await signedIn(origin, boss);
  const tenantId = await createTenant(origin, owner);
  const otherTenantId = await createTenant(origin, owner);
  const landing = `${portal}/invite/${tenantId}`;
  const fromEmail = `${landing}?from=email`;
  const { db, close } = createDB(DATABASE);
  try {
    async function memberRole(tenant: string, headers = owner) {
      const roles = type({ data: type({ id: "string", name: "string" }).array() }).assert(await (await fetch(`${headers.origin}/api/tenants/${tenant}/roles`, { headers })).json()).data;
      return roles.find((role) => role.name === "member")!.id;
    }
    // The hub's first account: older than every other but those the next test makes.
    await db.update(schema.user).set({ createdAt: new Date(1000) }).where(eq(schema.user.email, boss));
    const member = await memberRole(tenantId);
    const Sent = type({ principalId: "string", email: "string", emailed: "boolean", "link?": "string" });
    async function invite(hub: string, email: string) {
      const res = await fetch(`${hub}/api/integrations/invitations/${tenantId}`, { method: "POST", headers: { ...owner, origin: hub }, body: JSON.stringify({ email, roleId: member }) });
      return { status: res.status, body: await res.json() };
    }
    async function resend(principalId: string) {
      const res = await fetch(`${origin}/api/integrations/invitations/${tenantId}/${principalId}/resend`, { method: "POST", headers: owner });
      return { status: res.status, body: await res.json() };
    }
    function mailedLinks(email: string, pattern = /http\S+magic-link\/verify\S+/): string[] {
      return smtp.sent().filter((mail) => mail.headers.to === email).map((mail) => pattern.exec(mail.text)?.[0]).filter((link) => link !== undefined);
    }
    let follows = 0;
    async function follow(link: string) {
      follows += 1;
      const res = await fetch(link, { redirect: "manual", headers: { "x-forwarded-for": `203.0.113.${follows}` } });
      const cookie = res.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
      return { location: res.headers.get("location"), headers: { "content-type": "application/json", origin, cookie } };
    }
    async function accept(headers: Record<string, string>, tenant = tenantId, hub = origin) {
      const res = await fetch(`${hub}/api/integrations/invite-accept`, { method: "POST", headers: { ...headers, origin: hub }, body: JSON.stringify({ tenantId: tenant }) });
      return { status: res.status, body: await res.json() };
    }
    async function statusOf(email: string) {
      const principals = type({ data: type({ id: "string", "email?": "string", status: "string" }).array() })
        .assert(await (await fetch(`${origin}/api/tenants/${tenantId}/principals?kind=user`, { headers: owner })).json()).data;
      return principals.find((principal) => principal.email === email);
    }
    async function withdraw(principalId: string) {
      return (await fetch(`${origin}/api/integrations/invitations/${tenantId}/${principalId}`, { method: "DELETE", headers: owner })).status;
    }
    async function resetPassword(email: string, password: string, ip: string) {
      const headers = { "content-type": "application/json", origin, "x-forwarded-for": ip };
      const asked = await fetch(`${origin}/api/auth/request-password-reset`, { method: "POST", headers, body: JSON.stringify({ email, redirectTo: `${portal}/reset-password` }) });
      expect(asked.status).toBe(200);
      const token = /reset-password\/([^?\s]+)/.exec(mailedLinks(email, /http\S+reset-password\S+/).at(-1)!)![1]!;
      const reset = await fetch(`${origin}/api/auth/reset-password`, { method: "POST", headers, body: JSON.stringify({ token, newPassword: password }) });
      expect(reset.status).toBe(200);
    }
    async function passwordSignIn(email: string, password: string, ip: string) {
      return (await fetch(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": ip }, body: JSON.stringify({ email, password }) })).status;
    }

    expect((await fetch(`${origin}/api/auth/sign-in/magic-link`, { method: "POST", headers: owner, body: JSON.stringify({ email: ann }) })).status).toBe(404);

    expect(await invite(origin, ann)).toMatchObject({ status: 201, body: { email: ann, emailed: true } });
    expect(smtp.sent().find((mail) => mail.headers.to === ann)?.headers).toMatchObject({ from: "Triage <triage@example.com>", subject: "Join Acme on Corbits Triage" });
    expect(await statusOf(ann)).toMatchObject({ status: "invited" });
    expect(await invite(origin, ann)).toMatchObject({ status: 409 });
    const annLink = mailedLinks(ann)[0]!;
    const annIn = await follow(annLink);
    expect(annIn.location).toBe(fromEmail);
    expect(await accept(annIn.headers, otherTenantId)).toMatchObject({ status: 404 });
    expect(await accept(annIn.headers)).toEqual({ status: 200, body: { tenantId } });
    expect(await statusOf(ann)).toMatchObject({ status: "active" });
    // A member without `principal:*` create may not invite, and a signed-in non-member reaches nothing.
    const invitations = `${origin}/api/integrations/invitations/${tenantId}`;
    async function refusal(headers: Record<string, string>, method: string, path: string, body?: unknown) {
      const res = await fetch(`${invitations}${path}`, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    }
    const noGrant = { status: 403, body: { error: { code: "forbidden", message: "You do not have permission to perform this action" } } };
    const annId = (await statusOf(ann))!.id;
    expect(await refusal(annIn.headers, "GET", "")).toEqual(noGrant);
    expect(await refusal(annIn.headers, "POST", "", { email: emailOf("zed"), roleId: member })).toEqual(noGrant);
    expect(await refusal(annIn.headers, "POST", `/${annId}/resend`)).toEqual(noGrant);
    expect(await refusal(annIn.headers, "DELETE", `/${annId}`)).toEqual(noGrant);
    expect(await refusal(await signedIn(origin), "GET", "")).toEqual({ status: 403, body: { error: { code: "forbidden", message: "Not a member of this tenant" } } });
    // Triage's own role is never offered to, or given to, a person.
    const triageRole = await db.transaction(async function addTriageRole(tx) {
      return ensureTriageRole(tx, tenantId, new Date());
    });
    expect((await refusal(owner, "GET", "")).body).toMatchObject({ assignableRoleIds: expect.not.arrayContaining([triageRole]) });
    expect(await refusal({ ...owner, origin }, "POST", "", { email: emailOf("tri"), roleId: triageRole })).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    const malformed = await fetch(invitations, { method: "POST", headers: { ...owner, origin }, body: "{" });
    expect({ status: malformed.status, body: await malformed.json() }).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    expect(await follow(annLink)).toMatchObject({ location: `${fromEmail}&error=INVALID_TOKEN` });

    // Signed in only by the magic link, the invitee sets a password through the stock reset.
    await resetPassword(ann, "password-654321", "198.51.100.211");
    expect(await passwordSignIn(ann, "password-654321", "198.51.100.201")).toBe(200);

    // A reset proves the mailbox too, so an invitee who sets a password before following the link can accept, and keeps it.
    expect(await invite(origin, gil)).toMatchObject({ status: 201 });
    await resetPassword(gil, "password-777777", "198.51.100.212");
    const gilSignIn = await fetch(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", origin, "x-forwarded-for": "198.51.100.213" }, body: JSON.stringify({ email: gil, password: "password-777777" }) });
    const gilHeaders = { "content-type": "application/json", origin, cookie: gilSignIn.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
    expect(await accept(gilHeaders)).toEqual({ status: 200, body: { tenantId } });
    await follow(mailedLinks(gil)[0]!);
    expect(await passwordSignIn(gil, "password-777777", "198.51.100.214")).toBe(200);

    // Whoever registered an address unverified may not own it, so it is neither invited nor able to accept.
    const squatter = await signedIn(origin, bob, false);
    expect(await invite(origin, bob)).toMatchObject({ status: 409, body: { error: { code: "unverified_email" } } });
    expect(await accept(squatter)).toMatchObject({ status: 403, body: { error: { code: "email_unverified" } } });

    const catInvite = Sent.assert((await invite(origin, cat)).body);
    await db.execute(sql`UPDATE verification SET expires_at = now() WHERE value LIKE ${`%${cat}%`}`);
    expect(await follow(mailedLinks(cat)[0]!)).toMatchObject({ location: `${fromEmail}&error=INVALID_TOKEN` });
    expect(await statusOf(cat)).toMatchObject({ status: "invited" });
    expect(await resend(catInvite.principalId)).toMatchObject({ status: 429 });
    await db.update(schema.principal).set({ updatedAt: new Date(Date.now() - 120_000) }).where(eq(schema.principal.id, catInvite.principalId));
    expect(await resend(catInvite.principalId)).toMatchObject({ status: 200, body: { email: cat, emailed: true } });
    const catIn = await follow(mailedLinks(cat)[1]!);
    expect((await accept(catIn.headers)).status).toBe(200);
    expect(await resend(catInvite.principalId)).toMatchObject({ status: 404 });

    // Withdrawing frees a new address the invite claimed, so it can still sign up.
    const eveInvite = Sent.assert((await invite(origin, eve)).body);
    expect(await withdraw(eveInvite.principalId)).toBe(204);
    expect(await statusOf(eve)).toBeUndefined();
    expect(await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, eve))).toEqual([]);
    await signedIn(origin, eve);

    // Withdrawing does not reset what an address was sent, so inviting and withdrawing in a loop stops.
    for (let sent = 0; sent < 5; sent++) expect(await withdraw(Sent.assert((await invite(origin, fay)).body).principalId)).toBe(204);
    expect(await invite(origin, fay)).toMatchObject({ status: 429 });

    // Without email the inviter holds the link, so it signs nobody in and only an invitee an admin has verified can accept.
    expect(await invite(noEmail, emailOf("nobody"))).toMatchObject({ status: 404, body: { error: { message: expect.stringContaining("Ask them to sign in, then invite them again.") } } });
    const deeSession = { ...await signedIn(noEmail, dee, false), origin: noEmail };
    const copied = Sent.assert((await invite(noEmail, dee)).body);
    expect(copied).toMatchObject({ emailed: false, link: landing });
    expect(await statusOf(dee)).toMatchObject({ status: "invited" });
    expect(await accept(deeSession, tenantId, noEmail)).toMatchObject({ status: 403, body: { error: { code: "email_unverified" } } });
    expect((await refusal(owner, "GET", "")).body).toMatchObject({ unverifiedPrincipalIds: [] });
    expect(await refusal(owner, "POST", `/${copied.principalId}/verify`)).toMatchObject({ status: 409, body: { error: { code: "sends_email" } } });
    async function onNoEmail(headers: Record<string, string>, method: string, path: string) {
      const res = await fetch(`${noEmail}/api/integrations/invitations/${tenantId}${path}`, { method, headers: { ...headers, origin: noEmail } });
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    }
    expect((await onNoEmail(owner, "GET", "")).body).toMatchObject({ unverifiedPrincipalIds: [copied.principalId], canMarkVerified: true });

    // Verified holds hub-wide, so only the hub's first account verifies, never another workspace's admin, and only someone in its own workspace.
    const otherAdmin = await signedIn(noEmail);
    const theirTenantId = await createTenant(noEmail, otherAdmin);
    const theirInvite = await fetch(`${noEmail}/api/integrations/invitations/${theirTenantId}`, { method: "POST", headers: otherAdmin, body: JSON.stringify({ email: dee, roleId: await memberRole(theirTenantId, otherAdmin) }) });
    const deeInTheirs = Sent.assert(await theirInvite.json()).principalId;
    const theirs = await fetch(`${noEmail}/api/integrations/invitations/${theirTenantId}`, { headers: otherAdmin });
    expect(await theirs.json()).toMatchObject({ unverifiedPrincipalIds: [deeInTheirs], canMarkVerified: false });
    const vouched = await fetch(`${noEmail}/api/integrations/invitations/${theirTenantId}/${deeInTheirs}/verify`, { method: "POST", headers: otherAdmin });
    expect({ status: vouched.status, body: await vouched.json() }).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    const outsider = `outsider-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await signedIn(noEmail, outsider, false);
    const elsewhere = await fetch(`${noEmail}/api/integrations/invitations/${otherTenantId}`, { method: "POST", headers: { ...owner, origin: noEmail }, body: JSON.stringify({ email: outsider, roleId: await memberRole(otherTenantId) }) });
    const outsiderId = Sent.assert(await elsewhere.json()).principalId;
    expect(await onNoEmail(owner, "POST", `/${outsiderId}/verify`)).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect(await onNoEmail(gilHeaders, "POST", `/${copied.principalId}/verify`)).toEqual(noGrant);
    expect((await onNoEmail(owner, "POST", `/${copied.principalId}/verify`)).status).toBe(204);
    expect(noEmailOutput.filter((line) => line.includes("email_marked_verified")).map((line) => JSON.parse(line))).toMatchObject([{ tenantId, principalId: copied.principalId, byPrincipalId: expect.any(String) }]);
    expect(await onNoEmail(owner, "POST", `/${copied.principalId}/verify`)).toMatchObject({ status: 404 });
    expect(await accept(deeSession, tenantId, noEmail)).toEqual({ status: 200, body: { tenantId } });
    expect(await statusOf(dee)).toMatchObject({ status: "active" });

    expect(await invite(origin, bounce)).toMatchObject({ status: 502, body: { error: { code: "email_failed" } } });
    expect(output.filter((line) => line.includes("invite_email_failed")).map((line) => JSON.parse(line))).toMatchObject([{ code: "EENVELOPE" }]);
    expect(output.join("\n")).not.toContain(bounce);
  } finally {
    await close();
    smtp.stop();
  }
}, 60_000);

test("an unverified account reaches only sign-in and verification until it follows its emailed link, except the hub's first account", async () => {
  const smtp = smtpSink();
  const mail = { SMTP_URL: smtp.url, EMAIL_FROM: "Triage <triage@example.com>" };
  const origin = await startHub(mail);
  const noEmail = await startHub();
  const allowlisted = await startHub({ ...mail, AUTH_ALLOWED_EMAILS: "@allowed.test" });
  const { db, close } = createDB(DATABASE);
  try {
    async function status(hub: string, headers: Record<string, string>, method: string, path: string, body?: unknown) {
      const res = await fetch(`${hub}${path}`, { method, headers: { ...headers, origin: hub }, ...(body !== undefined && { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    }
    const refused = { status: 403, body: { error: { code: "email_unverified", message: "Verify your email address to use Corbits Triage." } } };
    function verifyLinks(email: string): string[] {
      return smtp.sent().filter((sent) => sent.headers.to === email).map((sent) => /http\S+verify-email\S+/.exec(sent.text)?.[0]).filter((link) => link !== undefined);
    }
    async function follow(link: string) {
      const res = await fetch(link, { redirect: "manual" });
      return { location: res.headers.get("location"), cookie: res.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
    }

    // Without email, only the hub's first account is let through unverified.
    const first = `first-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const firstSession = await signedIn(noEmail, first, false);
    await db.update(schema.user).set({ createdAt: new Date(0) }).where(eq(schema.user.email, first));
    const secondSession = await signedIn(noEmail, undefined, false);
    expect(await status(noEmail, firstSession, "GET", "/api/me")).toMatchObject({ status: 200, body: { email: first } });
    expect(await status(noEmail, secondSession, "GET", "/api/me")).toEqual(refused);
    expect(await status(noEmail, secondSession, "GET", "/api/integrations/auth-methods")).toMatchObject({ status: 200, body: { verificationEmail: false } });

    const ann = `ann-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const annSession = await signedIn(origin, ann, false);
    expect(await status(origin, annSession, "GET", "/api/me")).toEqual(refused);
    expect(await status(origin, annSession, "POST", "/api/tenants", { name: "Ann", slug: `ann-${crypto.randomUUID().slice(0, 8)}` })).toEqual(refused);
    expect(await status(origin, annSession, "GET", "/api/integrations/sessions")).toEqual(refused);
    expect(await status(origin, annSession, "GET", "/api/auth/get-session")).toMatchObject({ status: 200, body: { user: { email: ann, emailVerified: false } } });
    expect(await status(origin, annSession, "GET", "/api/integrations/auth-methods")).toMatchObject({ status: 200, body: { verificationEmail: true } });
    expect(await status(origin, annSession, "POST", "/api/hooks/nothing", {})).toEqual({ status: 404, body: { error: "unknown_hook" } });
    expect(smtp.sent().find((sent) => sent.headers.to === ann)?.headers).toMatchObject({ subject: "Verify your Corbits Triage email" });

    // Limited per account, whatever address the request claims to come from.
    const resend = { email: ann, callbackURL: "/inbox" };
    expect((await status(origin, { ...annSession, "x-forwarded-for": "198.51.100.240" }, "POST", "/api/auth/send-verification-email", resend)).status).toBe(200);
    expect((await status(origin, { ...annSession, "x-forwarded-for": "198.51.100.242" }, "POST", "/api/auth/send-verification-email", resend)).status).toBe(429);
    const links = verifyLinks(ann);
    expect(links).toHaveLength(2);
    expect(await follow(links[1]!)).toMatchObject({ location: "/inbox" });
    expect(await status(origin, annSession, "GET", "/api/me")).toMatchObject({ status: 200, body: { email: ann } });

    // An allowlist with email admits email/password sign-ups in it once verified, and exempts nobody.
    const outsider = await fetch(`${allowlisted}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: allowlisted, "x-forwarded-for": "198.51.100.241" },
      body: JSON.stringify({ email: `out-${crypto.randomUUID().slice(0, 8)}@example.com`, password: "password-123456", name: "Out" }),
    });
    expect(outsider.status).toBe(403);
    const ally = `ally-${crypto.randomUUID().slice(0, 8)}@allowed.test`;
    const allySession = await signedIn(allowlisted, ally, false);
    await db.update(schema.user).set({ createdAt: new Date(-1) }).where(eq(schema.user.email, ally));
    expect(await status(allowlisted, allySession, "GET", "/api/me")).toEqual(refused);
    const allyIn = await follow(verifyLinks(ally)[0]!);
    expect(await status(allowlisted, { cookie: allyIn.cookie }, "GET", "/api/me")).toMatchObject({ status: 200, body: { email: ally } });
  } finally {
    await close();
    smtp.stop();
  }
}, 60_000);
