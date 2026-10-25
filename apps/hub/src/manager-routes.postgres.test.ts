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
import { createManagerRoutes, MANAGER_RUN_TOKEN_ROUTES, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "./manager-routes.js";
import { ManagerUnavailableError, type ManagerIntake } from "./manager-intake.js";
import { MAX_BODY_BYTES } from "./read-json.js";
import { claimForIntake, markLive, recordEvent, type PullRequestRef } from "./manager-state.js";
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

/** The intake records the event as the real one does; starting and nudging the manager is manager-intake's test. */
function recordOnly(db: Db): ManagerIntake {
  return async function intake(tenantId, pr, deliveryId, event) {
    return { recorded: await recordEvent(db, tenantId, pr, deliveryId, event) };
  };
}

function routeDeps(db: Db, intake: ManagerIntake = recordOnly(db)) {
  return { db, requireGrant: createRequireGrant({ grantStore: createGrantStore(db), conditionRegistry: HUB_CONDITION_REGISTRY }), intake, log: ignore };
}

function buildHub(db: Db, intake?: ManagerIntake) {
  const app = buildStock(db);
  mountTenantRoutes(app, { ...routeDeps(db, intake), now: () => new Date() });
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

async function allowManagerState(db: Db, principalId: string): Promise<void> {
  await db.insert(schema.grant).values({ id: randomUUID(), tenantId: TENANT, principalId, resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION, effect: "allow", origin: "creator" });
}

/** A running workflow run with its own principal, and the run token its tool presents. */
async function runWithToken(db: Db, runId: string, granted: boolean): Promise<string> {
  const principalId = `prn_${runId}`;
  await db.insert(schema.principal).values({ id: principalId, tenantId: TENANT, kind: "workflow", refId: runId, status: "active" });
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, principalId, status: "running" });
  if (granted) await allowManagerState(db, principalId);
  const tokens = createRunTokenStore({ db, cipher: createNoopCredentialCipher() });
  await tokens.mintIfAbsent({ principalId, consumers: ["tool:@corbits/triage-manager"] }, db);
  const [delivery] = await tokens.loadDelivery(principalId);
  return delivery!.token;
}

async function startManager(db: Db, pr: PullRequestRef, runId: string): Promise<void> {
  await recordEvent(db, TENANT, pr, `delivery-${pr.source}`, { type: "webhook", head: "h1", payload: { action: "opened" } });
  const claimed = await claimForIntake(db, TENANT, pr);
  if (claimed.outcome !== "won") throw new Error(`expected to win, got ${claimed.outcome}`);
  expect(await markLive(db, TENANT, pr, claimed.claimId, runId)).toBe(true);
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
    const manager = bearer(await runWithToken(db, "run_manager", true));
    const reviewer = bearer(await runWithToken(db, "run_reviewer", true));
    for (const pr of [GITHUB, BITBUCKET]) {
      await startManager(db, pr, "run_manager");

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
      expect(await more.json()).toEqual({ outcome: "more" });

      expect(await (await post(app, "take", pr, manager)).json()).toMatchObject({ outcome: "pass", events: [{ key: `evt:${pr.source}:${pr.repo}#7:run_reviewer`, event: { type: "reviewer-result", payload: { kind: "code-review", result: REVIEW } } }] });
      expect(await (await post(app, "done", { ...pr, reviewers: [] }, manager)).json()).toEqual({ outcome: "ended" });
    }
  });
}, 60_000);

test("PostgreSQL: a run the claim does not name, a session and a run without the grant are refused", async () => {
  await withDatabase(async function refusals(db) {
    const app = buildHub(db);
    await allowManagerState(db, "prn_member");
    const manager = bearer(await runWithToken(db, "run_manager", true));
    const other = bearer(await runWithToken(db, "run_other", true));
    const ungranted = bearer(await runWithToken(db, "run_ungranted", false));
    await startManager(db, GITHUB, "run_manager");

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
    expect(await (await post(app, "take", GITHUB, manager)).json()).toMatchObject({ outcome: "pass", pass: { takes: 1 } });
  });
}, 60_000);

test("PostgreSQL: a reviewer result in a workspace with no manager to start is refused as unavailable", async () => {
  await withDatabase(async function unavailable(db) {
    const app = buildHub(db, async function noManager() {
      throw new ManagerUnavailableError("No manager is published for github.");
    });
    const reviewer = bearer(await runWithToken(db, "run_reviewer", true));
    const response = await post(app, "reviewer-result", { ...GITHUB, head: "h1", result: { verdict: "pass" } }, reviewer);
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("manager_unavailable");
  });
}, 60_000);

test("PostgreSQL: a malformed, non-JSON or oversized body is refused before the store is touched", async () => {
  await withDatabase(async function malformed(db) {
    const app = buildHub(db);
    const manager = bearer(await runWithToken(db, "run_manager", true));
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
