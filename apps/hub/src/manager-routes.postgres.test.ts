// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { inspectRoutes } from "hono/dev";
import { type } from "arktype";
import { createNoopCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, createRunTokenStore, runMigrations, schema } from "@intx/db";
import { createApp, createRequireGrant, HUB_CONDITION_REGISTRY, type GetSession } from "@intx/hub-api";
import { createEventCollectorRegistry, createSidecarRouter, type SessionService } from "@intx/hub-sessions";
import { matchesRunTokenRoute } from "../../../vendor/interchange/packages/hub-api/src/middleware/run-token-auth.js";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "@corbits/triage-contracts";
import { createOverdueWake, createSupersede } from "./manager-intake.js";
import { createManagerRoutes, MANAGER_RUN_TOKEN_ROUTES } from "./manager-routes.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { passRequest, recordEvent, type PullRequestRef } from "./manager-state.js";
import { createVerdictRecordStore } from "./github/verdict-record-store.js";
import { mountTenantRoutes } from "./tenant-routes.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_manager";
const USER = { id: "usr_member", email: "member@manager.test", emailVerified: true, name: "Member", image: null, createdAt: new Date(), updatedAt: new Date() };
const SESSION = { id: "ses_member", userId: USER.id, token: "tok_member", expiresAt: new Date("2999-01-01"), createdAt: new Date(), updatedAt: new Date() };
const GITHUB: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const BITBUCKET: PullRequestRef = { source: "bitbucket-datacenter", repo: "ACME/widgets", number: 7 };
const REVIEW = { summary: "No bugs.", comments: [], budgetExhausted: false };
const OpenApi = type({ paths: "Record<string, Record<string, unknown>>" });
const Operation = type({ requestBody: { content: { "application/json": { schema: "object" } } }, responses: { 200: { content: { "application/json": { schema: "object" } } }, 400: "object", 403: "object", 413: "object" } });
const FencedOperation = Operation.and({ responses: { 409: "object" } });

type Db = ReturnType<typeof createDB>["db"];

const getSession: GetSession = async function sessionOf(headers) {
  return headers.get("cookie") === "member" ? { user: USER, session: SESSION } : null;
};
const sessionService: SessionService = {
  stageWorkflowStep() {
    throw new Error("not used");
  },
  endSession() {
    throw new Error("not used");
  },
};

function buildStock(db: Db) {
  return createApp({
    getSession,
    authHandler: () => new Response(null, { status: 404 }),
    db,
    sidecarRouter: createSidecarRouter({
      withExecutableWorkflowRun: async (_target, send) => send(),
      authenticateSidecar: async ({ sidecarId }) => ({ sidecarId }),
      resolveSidecarBindings: async () => [],
      validateSidecarIdentity: async () => true,
    }),
    sessionService,
    eventCollectors: createEventCollectorRegistry({ db }),
    assetService: null,
    repoStore: null,
    maxTarballBytes: 10_000_000,
    credentialCipher: createNoopCredentialCipher(),
    extraRunTokenRoutes: MANAGER_RUN_TOKEN_ROUTES,
  });
}

function ignore(): void {}

type Woken = { tenantId: string; pr: PullRequestRef; head: string };

/** The hub's wake, recording each pull request it wakes; `listening` false is a workspace with no listener for the host. */
function waker(woken: Woken[] = [], listening = true) {
  return async function wake(tenantId: string, pr: PullRequestRef, head: string): Promise<boolean> {
    if (listening) woken.push({ tenantId, pr, head });
    return listening;
  };
}

async function unsuperseded(): Promise<void> {}

type RouteOptions = { log?: (entry: Record<string, unknown>) => void; wake?: ReturnType<typeof waker>; supersede?: (tenantId: string, pr: PullRequestRef) => Promise<void> };

function routeDeps(db: Db, { log = ignore, wake = waker(), supersede = unsuperseded }: RouteOptions = {}) {
  return { db, requireGrant: createRequireGrant({ grantStore: createGrantStore(db), conditionRegistry: HUB_CONDITION_REGISTRY }), log, wake, supersede };
}

function buildHub(db: Db, deps: RouteOptions = {}) {
  const app = buildStock(db);
  mountTenantRoutes(app, { ...routeDeps(db, deps), now: () => new Date() });
  return app;
}

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_manager_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Manager", slug: "manager", domain: "manager.test" });
    await handle.db.insert(schema.principal).values({ id: "prn_member", tenantId: TENANT, kind: "user", refId: USER.id, status: "active" });
    await handle.db.insert(schema.asset).values({ id: "ast_manager", tenantId: TENANT, kind: "workflow", name: "triage-manager", creatorPrincipalId: "prn_member" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_manager", tenantId: TENANT, name: "triage-manager", assetId: "ast_manager" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

const STATE = { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION };
const RESULT = { resource: MANAGER_RESULT_RESOURCE, action: MANAGER_RESULT_ACTION };
type Grant = typeof STATE | typeof RESULT;

async function allow(db: Db, principalId: string, { resource, action }: Grant): Promise<void> {
  await db.insert(schema.grant).values({ id: randomUUID(), tenantId: TENANT, principalId, resource, action, effect: "allow", origin: "creator" });
}

/** A running workflow run with its own principal and `grants`, and the run token its tool presents. */
async function runWithToken(db: Db, runId: string, grants: readonly Grant[]): Promise<string> {
  const principalId = `prn_${runId}`;
  await db.insert(schema.principal).values({ id: principalId, tenantId: TENANT, kind: "workflow", refId: runId, status: "active" });
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, principalId, status: "running" });
  for (const grant of grants) await allow(db, principalId, grant);
  const tokens = createRunTokenStore({ db, cipher: createNoopCredentialCipher() });
  await tokens.mintIfAbsent({ principalId, consumers: ["tool:@corbits/triage-manager"] }, db);
  const [delivery] = await tokens.loadDelivery(principalId);
  return delivery!.token;
}

async function webhook(db: Db, pr: PullRequestRef): Promise<void> {
  await recordEvent(db, TENANT, pr, `delivery-${pr.source}`, { type: "webhook", head: "h1", payload: { action: "opened" } });
}

function postText(app: ReturnType<typeof buildHub>, route: string, text: string, headers: Record<string, string>) {
  return app.request(`/api/tenants/${TENANT}/manager/${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: text });
}

function post(app: ReturnType<typeof buildHub>, route: string, body: unknown, headers: Record<string, string>) {
  return postText(app, route, JSON.stringify(body), headers);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function errorCode(response: Response): Promise<string> {
  return type({ error: { code: "string" } }).assert(await response.json()).error.code;
}

test("PostgreSQL: the manager's run token takes, finishes and a reviewer's records its result, on both hosts", async () => {
  await withDatabase(async function routes(db) {
    const app = buildHub(db);
    const manager = bearer(await runWithToken(db, "run_manager", [STATE]));
    const reviewer = bearer(await runWithToken(db, "run_reviewer", [RESULT]));
    for (const pr of [GITHUB, BITBUCKET]) {
      await webhook(db, pr);

      const taken = await post(app, "take", pr, manager);
      expect(taken.status).toBe(200);
      expect(await taken.json()).toMatchObject({ outcome: "pass", resumed: false, pass: { head: "h1", takes: 1 }, events: [{ event: { type: "webhook", head: "h1" } }] });

      const result = { ...pr, kind: "code-review", head: "h1", result: REVIEW };
      const reported = await post(app, "reviewer-result", result, reviewer);
      expect(reported.status).toBe(200);
      expect(await reported.json()).toEqual({ recorded: true });
      expect(await (await post(app, "reviewer-result", result, reviewer)).json()).toEqual({ recorded: false });

      const more = await post(app, "done", { ...pr, reviewers: [] }, manager);
      expect(more.status).toBe(200);
      expect(await more.json()).toEqual({ outcome: "more", wait: false });

      expect(await (await post(app, "take", pr, manager)).json()).toMatchObject({ outcome: "pass", events: [{ key: `evt:${pr.source}:${pr.repo}#7:run_reviewer`, event: { type: "reviewer-result", payload: { kind: "code-review", result: REVIEW } } }] });
      expect(await (await post(app, "done", { ...pr, reviewers: [] }, manager)).json()).toEqual({ outcome: "ended" });
    }
  });
}, 60_000);

test("PostgreSQL: a reviewer's result wakes the pull request's manager as a host event does, and one for a head the pull request moved past is dropped and logged", async () => {
  await withDatabase(async function woken(db) {
    const woken: Woken[] = [];
    const logged: Record<string, unknown>[] = [];
    function log(entry: Record<string, unknown>): void {
      logged.push(entry);
    }
    const app = buildHub(db, { log, wake: waker(woken) });
    const reviewer = bearer(await runWithToken(db, "run_reviewer", [RESULT]));
    await webhook(db, GITHUB);
    const result = { ...GITHUB, kind: "judge", head: "h1", failed: "the judge did not finish" };
    expect(await (await post(app, "reviewer-result", result, reviewer)).json()).toEqual({ recorded: true });
    expect(woken).toEqual([{ tenantId: TENANT, pr: GITHUB, head: "h1" }]);

    await recordEvent(db, TENANT, GITHUB, "pushed", { type: "webhook", head: "h2", payload: { kind: "pr", headSha: "h2" } });
    const late = bearer(await runWithToken(db, "run_late", [RESULT]));
    expect(await (await post(app, "reviewer-result", result, late)).json()).toEqual({ recorded: false });
    expect(woken).toHaveLength(1);
    expect(logged).toEqual([{ level: "info", msg: "reviewer_result_stale", tenantId: TENANT, ...GITHUB, kind: "judge", head: "h1", current: "h2", runId: "run_late" }]);
    const [stored] = await db.execute<{ events: number }>(sql`SELECT count(*)::int AS events FROM corbits_triage.manager_state WHERE key LIKE '%:run_late'`);
    expect(stored!.events).toBe(0);

    const unrouted = buildHub(db, { log, wake: waker([], false) });
    const quiet = bearer(await runWithToken(db, "run_quiet", [RESULT]));
    expect(await (await post(unrouted, "reviewer-result", { ...result, head: "h2" }, quiet)).json()).toEqual({ recorded: true });
    expect(logged.at(-1)).toMatchObject({ level: "warn", msg: "reviewer_result_unrouted", runId: "run_quiet" });
  });
}, 60_000);

test("PostgreSQL: a result whose wake fails stays recorded with nothing else, the route answers 502, and a reconcile pass wakes a manager for it once the start grace has passed since it was recorded", async () => {
  await withDatabase(async function unwoken(db) {
    const logged: Record<string, unknown>[] = [];
    function log(entry: Record<string, unknown>): void {
      logged.push(entry);
    }
    async function failingWake(): Promise<boolean> {
      throw new Error("delivery failed");
    }
    const app = buildHub(db, { log, wake: failingWake });
    const manager = bearer(await runWithToken(db, "run_manager", [STATE]));
    await webhook(db, GITHUB);
    await post(app, "take", GITHUB, manager);
    expect(await (await post(app, "done", { ...GITHUB, reviewers: [] }, manager)).json()).toEqual({ outcome: "ended" });
    await db.execute(sql`UPDATE workflow_run SET status = 'completed' WHERE id = 'run_manager'`);
    const before = await db.execute(sql`SELECT key, state FROM corbits_triage.manager_state WHERE kind = 'claim'`);

    const reviewer = bearer(await runWithToken(db, "run_reviewer", [RESULT]));
    const failed = await post(app, "reviewer-result", { ...GITHUB, kind: "judge", head: "h1", failed: "the judge did not finish" }, reviewer);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe("wake_failed");
    expect(logged).toEqual([{ level: "error", msg: "reviewer_result_wake_failed", tenantId: TENANT, ...GITHUB, kind: "judge", head: "h1", runId: "run_reviewer", error: "Error: delivery failed" }]);
    const [stored] = await db.execute<{ events: number }>(sql`SELECT count(*)::int AS events FROM corbits_triage.manager_state WHERE key LIKE '%:run_reviewer' AND state->>'consumedBy' IS NULL`);
    expect(stored!.events).toBe(1);
    expect(await db.execute(sql`SELECT key, state FROM corbits_triage.manager_state WHERE kind = 'claim'`)).toEqual(before);

    const woken: Woken[] = [];
    const wakeOverdue = createOverdueWake({ db, wake: waker(woken), log });
    await wakeOverdue(TENANT);
    expect(woken).toEqual([]);
    const earlier = new Date(Date.now() - 2 * 60_000 - 1_000).toISOString();
    await db.execute(sql`UPDATE corbits_triage.manager_state SET state = jsonb_set(state, '{receivedAt}', to_jsonb(${earlier}::text)) WHERE key LIKE '%:run_reviewer'`);
    await wakeOverdue(TENANT);
    expect(woken).toEqual([{ tenantId: TENANT, pr: GITHUB, head: "h1" }]);
    // The manager that wake deployed has not taken the claim yet, so the next pass does not deploy another.
    await wakeOverdue(TENANT);
    expect(woken).toHaveLength(1);
  });
}, 60_000);

test("PostgreSQL: done stops a reviewer the pass deployed on a head a push moved past, and takes it off the claim", async () => {
  await withDatabase(async function supersededMidPass(db) {
    const cancelled: string[] = [];
    const { supersede } = createSupersede({
      db,
      async cancel(_tenantId, runId) {
        cancelled.push(runId);
      },
      log: ignore,
    });
    const app = buildHub(db, { supersede });
    const manager = bearer(await runWithToken(db, "run_manager", [STATE]));
    await webhook(db, GITHUB);
    await post(app, "take", GITHUB, manager);
    await recordEvent(db, TENANT, GITHUB, "pushed", { type: "webhook", head: "h2", payload: { kind: "pr", headSha: "h2" } });
    const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
    const deployed = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_manager", deadline };
    expect(await (await post(app, "done", { ...GITHUB, reviewers: [deployed], wait: true }, manager)).json()).toEqual({ outcome: "more", wait: false });
    expect(cancelled).toEqual(["run_judge"]);
    const [claim] = await db.execute<{ state: { reviewers: unknown[] } }>(sql`SELECT state FROM corbits_triage.manager_state WHERE kind = 'claim'`);
    expect(claim!.state.reviewers).toEqual([]);
  });
}, 60_000);

/** The run as the stock deploy route launched it, from a published workflow whose frozen projection keeps its id. */
async function launchedAs(db: Db, runId: string, workflow: string): Promise<void> {
  await db.insert(schema.workflowRunLaunchSpec).values({
    anchorRunId: runId, sessionId: `ses_${runId}`, deploymentDomain: "manager.test", sourceAuthorityPrincipalId: "prn_member",
    frozenApprovalBundle: { projection: { id: workflow } }, sourceOfferingIds: [], defaultSourceOfferingId: "off_default", deployContent: {},
  });
}

async function mailed(db: Db, pr: PullRequestRef, head: string, action: string): Promise<void> {
  await recordEvent(db, TENANT, pr, `${action}-${pr.source}`, { type: "webhook", head, payload: { kind: "pr", event: "pull_request", action, headSha: head } });
}

/** What a pass that posted its verdict on `head` reports, as its evaluate, mirror, execute and rules steps output it. */
function postedOn(pr: PullRequestRef, head: string) {
  const target = { labels: ["api"] };
  const request = { repo: pr.repo, number: pr.number, labels: ["Triage: Pass"], owned: [], comment: "Ready for review." };
  const actions = [{ list: "pass", index: 0, effectId: `held-${head}`, kind: "labels", target, held: true }, { list: "pass", index: 1, effectId: `auto-${head}`, kind: "labels", target }];
  return {
    request,
    report: {
      head,
      verdict: { repo: pr.repo, number: pr.number, headSha: head, verdict: "pass", state: "ready-monitoring", actor: "author", humanGated: false, degraded: null, checks: [{ check: "title", kind: "machine", result: "pass" }], actions, request },
      mirror: { call: `mirror:${pr.repo.replace("/", "--")}:${pr.number}`, ok: true },
      executed: { dos: [{ effectId: `auto-${head}`, status: "done" }] },
      rules: { items: [{ facts: { repo: pr.repo, number: pr.number, title: "Fix the widget", author: "octocat" }, det: { findings: [{ reason: "The title says what changed." }] } }] },
    },
  };
}

test("PostgreSQL: done records the verdict a pass posted as its run's on its host, the run's newest replaces it keeping the Dos written on its head, approvals set their outcomes and a held head records none", async () => {
  await withDatabase(async function recorded(db) {
    const app = buildHub(db);
    const verdicts = createVerdictRecordStore(db);
    for (const pr of [GITHUB, BITBUCKET]) {
      const runId = `run_${pr.source}`;
      const manager = bearer(await runWithToken(db, runId, [STATE]));
      await launchedAs(db, runId, `triage-manager-${pr.source}`);

      await mailed(db, pr, "h1", "opened");
      await post(app, "take", pr, manager);
      const first = postedOn(pr, "h1");
      expect(await (await post(app, "done", { ...pr, reviewers: [], report: first.report }, manager)).json()).toEqual({ outcome: "ended" });
      expect(await verdicts.latestFor(TENANT, pr)).toMatchObject({
        runId, source: pr.source, headSha: "h1", runStatus: "completed", state: "ready-monitoring", settled: true, commented: true, trigger: "pull_request:opened",
        checks: [{ check: "title", result: "pass" }], dos: [{ list: "pass", effectId: "held-h1" }, { list: "pass", effectId: "auto-h1" }],
        detail: { headSha: "h1", facts: { title: "Fix the widget", author: "octocat" }, evidence: ["The title says what changed."], actions: [{ effectId: "held-h1", held: true }, { effectId: "auto-h1", status: "done" }] },
      });
      expect(await passRequest(db, TENANT, pr, runId, "h1")).toEqual(first.request);

      await mailed(db, pr, "h2", "synchronize");
      await post(app, "take", pr, manager);
      const approvals = { results: [{ dos: [{ effectId: "held-h2", status: "done" }] }] };
      await post(app, "done", { ...pr, reviewers: [], report: postedOn(pr, "h2").report }, manager);
      await post(app, "take", pr, manager);
      await post(app, "done", { ...pr, reviewers: [], approvals }, manager);
      const rows = await verdicts.forPull(TENANT, pr.repo, pr.number);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ runId, headSha: "h2", trigger: "pull_request:synchronize", detail: { actions: [{ effectId: "held-h2", status: "done" }, { effectId: "auto-h2", status: "done" }] } });

      // Mailed again on the same head, its next verdict keeps the Do already written there, the run's start on the head and the head's newest mail.
      await mailed(db, pr, "h2", "edited");
      await post(app, "take", pr, manager);
      await post(app, "done", { ...pr, reviewers: [], report: postedOn(pr, "h2").report }, manager);
      expect(await verdicts.forPull(TENANT, pr.repo, pr.number)).toEqual([expect.objectContaining({
        startedAt: rows[0]!.startedAt, trigger: "pull_request:edited", detail: expect.objectContaining({ actions: [expect.objectContaining({ effectId: "held-h2", status: "done" }), expect.objectContaining({ effectId: "auto-h2", status: "done" })] }),
      })]);

      await mailed(db, pr, "h3", "reopened");
      await post(app, "take", pr, manager);
      expect(await (await post(app, "done", { ...pr, reviewers: [], report: { head: "h3", waiting: true } }, manager)).json()).toEqual({ outcome: "ended" });
      expect((await verdicts.forPull(TENANT, pr.repo, pr.number)).map((row) => row.headSha)).toEqual(["h2"]);
    }
  });
}, 60_000);

test("PostgreSQL: a run the claim does not name, a session and a run without the grant are refused", async () => {
  await withDatabase(async function refusals(db) {
    const app = buildHub(db);
    await allow(db, "prn_member", STATE);
    await allow(db, "prn_member", RESULT);
    const manager = bearer(await runWithToken(db, "run_manager", [STATE]));
    const other = bearer(await runWithToken(db, "run_other", [STATE]));
    const ungranted = bearer(await runWithToken(db, "run_ungranted", []));
    await webhook(db, GITHUB);
    expect(await (await post(app, "take", GITHUB, manager)).json()).toMatchObject({ outcome: "pass", pass: { takes: 1 } });

    const stale = await post(app, "take", GITHUB, other);
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("not_manager");
    const staleDone = await post(app, "done", { ...GITHUB, reviewers: [] }, other);
    expect(staleDone.status).toBe(409);
    expect(await errorCode(staleDone)).toBe("not_manager");

    for (const route of ["take", "done", "reviewer-result"]) {
      const body = { ...GITHUB, reviewers: [], head: "h1", result: {} };
      const session = await post(app, route, body, { cookie: "member" });
      expect(session.status).toBe(403);
      expect((await post(app, route, body, ungranted)).status).toBe(403);
    }
    expect(await (await post(app, "take", GITHUB, manager)).json()).toMatchObject({ outcome: "pass", resumed: true, pass: { takes: 2 } });
  });
}, 60_000);

test("PostgreSQL: a reviewer reports only with the result grant, and the result grant reaches no other manager route", async () => {
  await withDatabase(async function resultGrant(db) {
    const app = buildHub(db);
    const result = { ...GITHUB, kind: "code-review", head: "h1", result: REVIEW };
    const stateOnly = await post(app, "reviewer-result", result, bearer(await runWithToken(db, "run_state", [STATE])));
    expect(stateOnly.status).toBe(403);
    const reviewer = bearer(await runWithToken(db, "run_reviewer", [RESULT]));
    expect(await (await post(app, "reviewer-result", result, reviewer)).json()).toEqual({ recorded: true });
    expect((await post(app, "take", GITHUB, reviewer)).status).toBe(403);
    expect((await post(app, "done", { ...GITHUB, reviewers: [] }, reviewer)).status).toBe(403);
  });
}, 60_000);

test("PostgreSQL: a malformed, non-JSON or oversized body is refused before the store is touched", async () => {
  await withDatabase(async function malformed(db) {
    const app = buildHub(db);
    const manager = bearer(await runWithToken(db, "run_manager", [STATE, RESULT]));
    const bodies: [string, unknown][] = [
      ["take", { ...GITHUB, source: "gitlab" }],
      ["take", { source: "github", repo: "widgets", number: 7 }],
      ["take", { ...GITHUB, number: 0 }],
      ["done", GITHUB],
      ["done", { ...GITHUB, reviewers: [{ kind: "judge" }] }],
      ["reviewer-result", { ...GITHUB, kind: "code-review", head: "h1", result: { verdict: "pass" } }],
      ["reviewer-result", { ...GITHUB, kind: "code-review", result: REVIEW }],
    ];
    for (const [route, body] of bodies) {
      const response = await post(app, route, body, manager);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
    for (const route of ["take", "done", "reviewer-result"]) {
      const response = await postText(app, route, "{not json", manager);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_request");
    }
    const oversized = await post(app, "reviewer-result", { ...GITHUB, head: "h1", result: { summary: "x".repeat(MAX_BODY_BYTES) } }, manager);
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("too_large");
    const [{ rows }] = await db.execute<{ rows: number }>(sql`SELECT count(*)::int AS rows FROM corbits_triage.manager_state`);
    expect(rows).toBe(0);
  });
}, 60_000);

test("PostgreSQL: every extra run-token route is a fixed tenant path that names exactly one hub route, a manager route", async () => {
  await withDatabase(async function guard(db) {
    const handlers = inspectRoutes(buildHub(db)).filter((route) => !route.isMiddleware);
    const managed = inspectRoutes(createManagerRoutes(routeDeps(db))).filter((route) => !route.isMiddleware).map((route) => `${route.method} /api/tenants/:tenantId${route.path}`);
    expect(MANAGER_RUN_TOKEN_ROUTES.length).toBeGreaterThan(0);
    for (const extra of MANAGER_RUN_TOKEN_ROUTES) {
      expect(extra.path).toMatch(/^\/api\/tenants\/:tenantId(\/[^/:*{}]+)+$/);
      const matched = handlers.filter((route) => (route.method === extra.method || route.method === "ALL") && matchesRunTokenRoute(route.path, extra.path));
      expect(matched.map((route) => `${route.method} ${route.path}`)).toEqual([`${extra.method} ${extra.path}`]);
      expect(managed).toContain(`${extra.method} ${extra.path}`);
    }
  });
}, 60_000);

test("PostgreSQL: /openapi.json documents each manager route's request and responses", async () => {
  await withDatabase(async function openapi(db) {
    const spec = OpenApi.assert(await (await buildHub(db).request("/openapi.json")).json());
    for (const extra of MANAGER_RUN_TOKEN_ROUTES) {
      const operation = spec.paths[extra.path.replace(":tenantId", "{tenantId}")]?.post;
      const fenced = extra.path.endsWith("/take") || extra.path.endsWith("/done");
      expect((fenced ? FencedOperation : Operation).allows(operation)).toBe(true);
    }
  });
}, 60_000);
