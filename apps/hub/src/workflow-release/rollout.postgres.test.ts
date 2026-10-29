// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { createEnvKeyCredentialCipher, generateKeyPair } from "@intx/crypto";
import { createDB, createGrantStore, createPrincipalKeyStore, runMigrations, schema } from "@intx/db";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createAgentRepoStore, createAssetService, DEFAULT_ASSET_REF, type AssetService, type RepoStore } from "@intx/hub-sessions";
import { DEPLOYER_GRANTS, REPO_SOURCES, type ModelInfo, type RepoSource, type SourceIndexEntry } from "@corbits/triage-contracts";
import { revokeHumanDeployers } from "../deployer-role.js";
import { createSystemWrites, SYSTEM_WRITER, SystemWriteDenied, type SystemWrites } from "../system-writes/writer.js";
import { publishRelease, type Bundle } from "./publish.js";
import { setUpPublisher } from "./publisher.js";
import { createWorkspaceLock } from "./reads.js";
import { createListenerWatch, releaseWriteOf } from "./triggers.js";
import { createRolloutQueue, createWorkflowRollout, START_DEADLINE_MS, type Deployment, type DeployRequest, type DeployState, type RollOutcome } from "./rollout.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const LISTENER = "triage-listener-github";
const MANAGER = "triage-manager-github";
const ROLL_FAILED = "Updating Triage failed; see the hub log.";
const NO_REDEPLOY = new Set<RepoSource>();
const REDEPLOY_GITHUB = new Set<RepoSource>(["github"]);

const INDEX: SourceIndexEntry[] = ["pr-code-review-reviewer-github", "triage-judge-github", MANAGER, LISTENER].map((workflow) => ({ workflow, hash: "0badc0de" }));

const bundle: Bundle = {
  async index() {
    return INDEX;
  },
  async tree({ workflow }) {
    return { "package.json": JSON.stringify({ name: workflow, private: true, workspaces: ["packages/*"] }), [`packages/${workflow}/release.json`]: "{}\n" };
  },
};

const DECISION: ModelInfo = { canonicalName: "decision", offerings: [{ offeringId: "off_decision", providerName: "corbits-system-one" }] };
const ANTHROPIC: ModelInfo[] = ["claude-opus-5-5", "claude-haiku-5-5"].map((canonicalName) => ({ canonicalName, offerings: [{ offeringId: `off_${canonicalName}`, providerName: "anthropic" }] }));

let handle: ReturnType<typeof createDB>;
let admin: ReturnType<typeof createDB>;
let database: string;
let dataDir: string;
let repoStore: RepoStore;
let assets: AssetService;
let writes: SystemWrites;

beforeAll(async () => {
  database = `corbits_release_${randomBytes(6).toString("hex")}`;
  admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  await runMigrations(config, { schema: "public" });
  handle = createDB(config);
  dataDir = await mkdtemp(path.join(os.tmpdir(), "workflow-release-"));
  repoStore = createAgentRepoStore({ dataDir, signingKey: await generateKeyPair() }).repoStore;
  assets = createAssetService({ db: handle.db, repoStore });
  writes = createSystemWrites({ db: handle.db, principalKeyStore: createPrincipalKeyStore({ db: handle.db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)) }) });
});

afterAll(async () => {
  await handle.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
  await rm(dataDir, { recursive: true, force: true });
});

type Run = Deployment & { workflow: string; state: DeployState; polls: number };

/** A workspace with its publisher, rolled against fake deployments. */
async function workspace(name: string) {
  const db = handle.db;
  const tenantId = `tnt_${name}`;
  const principalId = `prn_${name}_publisher`;
  await db.insert(schema.tenant).values({ id: tenantId, name, slug: name, domain: `${name}.test` });
  await db.insert(schema.role).values({ id: `rol_${name}_admin`, tenantId, name: "admin", isSystem: true });
  await db.insert(schema.grant).values(["read", "create", "manage"].map((action) => ({ id: `grt_${name}_admin_${action}`, tenantId, roleId: `rol_${name}_admin`, resource: "*", action, effect: "allow" as const, origin: "system" as const })));
  await db.insert(schema.principal).values({ id: principalId, tenantId, kind: "user", refId: "triage-publisher", status: "active" });
  const fake = {
    models: [DECISION] as ModelInfo[],
    starts: "live" as DeployState,
    deployFails: false,
    stopHangs: false,
    releasedAfterPolls: Infinity,
    statusFails: 0,
    clock: Date.now(),
    runs: [] as Run[],
    requests: [] as DeployRequest[],
    logs: [] as Array<Record<string, unknown>>,
  };
  const rollout = createWorkflowRollout({
    db, writes, assets, repoStore, bundle,
    async publisher(tenant) {
      await setUpPublisher(writes, tenant, principalId, new Date());
      return { tenantId: tenant, principalId };
    },
    async models() {
      return fake.models;
    },
    async connectedSources() {
      return ["github"];
    },
    async deployments(_tenant, workflow) {
      return fake.runs.filter((run) => run.workflow === workflow && run.state !== "ended");
    },
    async deploy(request) {
      if (fake.deployFails) throw new Error("no sidecar capacity");
      fake.requests.push(request);
      const runId = `run_${fake.requests.length}`;
      fake.runs.push({ runId, workflow: LISTENER, state: fake.starts, createdAt: new Date(fake.clock + fake.requests.length), cancelling: false, polls: 0, source: { assetId: request.assetId, commitSha: request.commitSha } });
      return runId;
    },
    async state(runId) {
      return fake.runs.find((run) => run.runId === runId)?.state ?? "ended";
    },
    async cancel(_tenant, runId) {
      const run = fake.runs.find((row) => row.runId === runId);
      if (run) run.cancelling = true;
    },
    live() {},
    async status(_tenant, runId) {
      if (fake.statusFails > 0) {
        fake.statusFails -= 1;
        throw new Error("status read failed");
      }
      const run = fake.runs.find((row) => row.runId === runId);
      if (!run) return null;
      run.polls += 1;
      const released = run.cancelling && run.polls >= fake.releasedAfterPolls;
      return {
        status: run.cancelling && !fake.stopHangs ? "cancelled" : "running",
        allocation: { id: `alc_${runId}`, generation: 1, status: released ? "releasing" : "allocated", failureCode: null, failureMessage: null },
      };
    },
    lock: createWorkspaceLock(handle.db.$client),
    async sleep(ms) {
      fake.clock += ms;
    },
    now: () => new Date(fake.clock),
    log(entry) {
      fake.logs.push(entry);
    },
  });
  function lastError(): unknown {
    return fake.logs.findLast((entry) => entry["msg"] === "workflow_release_failed")?.["error"];
  }
  function live(workflow = LISTENER): string[] {
    return fake.runs.filter((run) => run.workflow === workflow && run.state !== "ended" && !run.cancelling).map((run) => run.runId);
  }
  async function workflowAssets() {
    return db.select({ id: schema.asset.id, name: schema.asset.name, creator: schema.asset.creatorPrincipalId }).from(schema.asset).where(eq(schema.asset.tenantId, tenantId));
  }
  async function listenerAsset(): Promise<string> {
    const [newest] = fake.runs.filter((run) => run.workflow === LISTENER).toReversed();
    return newest!.source!.assetId;
  }
  return { tenantId, principalId, fake, rollout, live, lastError, workflowAssets, listenerAsset };
}

const SUCCEEDED: RollOutcome = { busy: false, failed: [] };
const FAILED: RollOutcome = { busy: false, failed: ["github"] };

test("PostgreSQL: the hub publishes once as the workspace's publisher, rolls again only for a new release or new credentials, and adds code review once its key is saved", async () => {
  const { tenantId, principalId, fake, rollout, live, workflowAssets, listenerAsset } = await workspace("release");
  async function managerRelease(assetId: string) {
    return JSON.parse(new TextDecoder().decode(await assets.readAssetBlob({ assetId, path: `packages/${MANAGER}/release.json` }))) as { github: Record<string, unknown> };
  }

  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  const first = await workflowAssets();
  expect(first.map((row) => row.name.split("-prn-")[0]).sort()).toEqual(["triage-judge-github", MANAGER, LISTENER].sort());
  expect(first.every((row) => row.creator === principalId)).toBe(true);
  expect(fake.requests).toEqual([expect.objectContaining({ tenantId, principalId, offerings: { ids: ["off_decision"], defaultId: "off_decision" } })]);
  expect(Object.keys((await managerRelease(first.find((row) => row.name.startsWith(MANAGER))!.id)).github)).toEqual(["judge"]);
  expect(rollout.rollouts(tenantId)).toEqual([{ source: "github", at: expect.any(String) }]);
  const grants = createGrantStore(handle.db);
  async function allowed(resource: string, action: string): Promise<boolean> {
    return (await authorize(grants, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
  }
  for (const { resource, action } of DEPLOYER_GRANTS) expect(await allowed(resource, action)).toBe(true);
  const listenerId = await listenerAsset();
  for (const row of first) expect(await allowed(`asset:${row.id}`, "read")).toBe(row.id !== listenerId);
  expect(await allowed("asset:*", "create")).toBe(false);
  const [tenant] = await handle.db.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  expect(tenant?.config).toMatchObject({ lifecycle: { maxLifetime: "36500d" } });

  await handle.db.insert(schema.user).values({ id: "usr_release_admin", email: "admin@release.test", name: "Admin" });
  await handle.db.insert(schema.principal).values({ id: "prn_release_admin", tenantId, kind: "user", refId: "usr_release_admin", status: "active" });
  const [deployer] = await handle.db.select({ roleId: schema.principalRole.roleId }).from(schema.principalRole).where(eq(schema.principalRole.principalId, principalId));
  await handle.db.insert(schema.principalRole).values({ principalId: "prn_release_admin", roleId: deployer!.roleId });
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(await workflowAssets()).toEqual(first);
  expect(fake.requests).toHaveLength(1);
  expect(await handle.db.select({ principalId: schema.principalRole.principalId }).from(schema.principalRole).where(eq(schema.principalRole.roleId, deployer!.roleId))).toEqual([{ principalId }]);

  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(fake.requests).toHaveLength(2);
  expect(fake.requests[1]).toMatchObject({ assetId: fake.requests[0]!.assetId, commitSha: fake.requests[0]!.commitSha });
  expect(live()).toEqual(["run_2"]);

  fake.models = [DECISION, ...ANTHROPIC];
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  const withReview = await workflowAssets();
  expect(withReview).toHaveLength(first.length + 3);
  const manager = withReview.filter((row) => row.name.startsWith(MANAGER)).find((row) => !first.some((old) => old.id === row.id))!;
  expect(Object.keys((await managerRelease(manager.id)).github).sort()).toEqual(["codeReview", "judge"]);
  expect(live()).toEqual(["run_3"]);
}, 120_000);

test("PostgreSQL: a new listener that ends, misses its deadline or cannot deploy leaves the running one, and the next roll that finds it current clears the failure", async () => {
  const { tenantId, fake, rollout, live } = await workspace("failing");
  await rollout.roll(tenantId, NO_REDEPLOY);
  expect(live()).toEqual(["run_1"]);

  fake.starts = "ended";
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(live()).toEqual(["run_1"]);
  expect(rollout.rollouts(tenantId)).toEqual([{ source: "github", at: expect.any(String), error: ROLL_FAILED }]);

  fake.starts = "starting";
  const before = fake.clock;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(fake.clock - before).toBeGreaterThanOrEqual(START_DEADLINE_MS);
  expect(fake.runs.find((run) => run.runId === "run_3")?.cancelling).toBe(true);
  expect(live()).toEqual(["run_1"]);

  fake.deployFails = true;
  const runs = fake.runs.length;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(fake.runs).toHaveLength(runs);
  expect(live()).toEqual(["run_1"]);

  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(rollout.rollouts(tenantId)).toEqual([{ source: "github", at: expect.any(String) }]);
  expect(live()).toEqual(["run_1"]);
}, 120_000);

test("PostgreSQL: once the newest listener runs the release, the listeners before it and the workflows it replaced stop without a third deploy", async () => {
  const { tenantId, fake, rollout, live, listenerAsset } = await workspace("restart");
  await rollout.roll(tenantId, NO_REDEPLOY);
  const release = { assetId: await listenerAsset(), commitSha: fake.requests[0]!.commitSha };
  fake.runs.push(
    { runId: "run_older", workflow: LISTENER, state: "live", createdAt: new Date(fake.clock - 60_000), cancelling: false, polls: 0, source: { assetId: "ast_old", commitSha: "old" } },
    { runId: "run_replaced", workflow: "pr-triage-github", state: "live", createdAt: new Date(fake.clock - 60_000), cancelling: false, polls: 0, source: null },
    { runId: "run_cut_short", workflow: LISTENER, state: "live", createdAt: new Date(fake.clock + 60_000), cancelling: false, polls: 0, source: release },
  );
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(fake.requests).toHaveLength(1);
  expect(live()).toEqual(["run_cut_short"]);
  expect(live("pr-triage-github")).toEqual([]);
}, 120_000);

test("PostgreSQL: a replaced listener or workflow that stays live once stock gave up stopping it is logged as stuck, and the roll succeeds", async () => {
  const { tenantId, fake, rollout, live } = await workspace("stuck");
  await rollout.roll(tenantId, NO_REDEPLOY);
  fake.runs.push({ runId: "run_historical", workflow: "pr-triage-historical", state: "live", createdAt: new Date(fake.clock - 60_000), cancelling: false, polls: 0, source: null });
  fake.stopHangs = true;
  fake.releasedAfterPolls = 3;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(live()).toEqual(["run_2"]);
  const stuck = fake.logs.filter((entry) => String(entry["msg"]).endsWith("_cancel_stuck"));
  expect(stuck).toHaveLength(2);
  expect(stuck).toEqual(expect.arrayContaining([
    { level: "warn", msg: "listener_cancel_stuck", tenantId, source: "github", deployment: "run_1" },
    { level: "warn", msg: "rollout_cancel_stuck", tenantId, source: "github", workflow: "pr-triage-historical", deployment: "run_historical" },
  ]));
}, 120_000);

test("PostgreSQL: a replaced listener stock neither stops nor gives up on is waited on five minutes from the stop request, then logged as stuck, and the roll succeeds", async () => {
  const { tenantId, fake, rollout, live } = await workspace("unanswered");
  await rollout.roll(tenantId, NO_REDEPLOY);
  fake.stopHangs = true;
  const before = fake.clock;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(fake.clock - before).toBeGreaterThanOrEqual(5 * 60_000);
  expect(live()).toEqual(["run_2"]);
  expect(fake.logs.filter((entry) => entry["msg"] === "listener_cancel_stuck")).toEqual([{ level: "warn", msg: "listener_cancel_stuck", tenantId, source: "github", deployment: "run_1" }]);
}, 120_000);

test("PostgreSQL: a stop wait retries a failed status read three times, and one that keeps failing is logged as stuck while the roll succeeds", async () => {
  const { tenantId, fake, rollout, live } = await workspace("unread");
  await rollout.roll(tenantId, NO_REDEPLOY);
  fake.statusFails = 3;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(fake.logs.filter((entry) => String(entry["msg"]).endsWith("_cancel_stuck"))).toEqual([]);
  fake.statusFails = 4;
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(live()).toEqual(["run_3"]);
  expect(fake.logs.filter((entry) => entry["msg"] === "listener_cancel_stuck")).toEqual([{ level: "warn", msg: "listener_cancel_stuck", tenantId, source: "github", deployment: "run_2", error: "status read failed" }]);
}, 120_000);

test("PostgreSQL: a roll neither waits on nor stops a listener it did not deploy that runs the release, however long it takes to start", async () => {
  const { tenantId, fake, rollout, live } = await workspace("replacing");
  await rollout.roll(tenantId, NO_REDEPLOY);
  fake.runs.push({ runId: "run_older", workflow: LISTENER, state: "live", createdAt: new Date(fake.clock - 60_000), cancelling: false, polls: 0, source: { assetId: "ast_old", commitSha: "old" } });
  fake.runs[0]!.state = "starting";
  fake.clock += START_DEADLINE_MS * 2;
  const before = fake.clock;
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(fake.clock).toBe(before);
  expect(fake.requests).toHaveLength(1);
  expect(live()).toEqual(["run_1"]);
}, 120_000);

test("PostgreSQL: the hub deploys no asset that someone else created or that holds another commit", async () => {
  const { tenantId, principalId, fake, rollout, lastError, listenerAsset } = await workspace("foreign");
  await rollout.roll(tenantId, NO_REDEPLOY);
  const assetId = await listenerAsset();

  await handle.db.update(schema.asset).set({ creatorPrincipalId: "prn_foreign_publisher" }).where(eq(schema.asset.id, assetId));
  await handle.db.insert(schema.principal).values({ id: "prn_someone", tenantId, kind: "user", refId: "usr_someone", status: "active" });
  await handle.db.update(schema.asset).set({ creatorPrincipalId: "prn_someone" }).where(eq(schema.asset.id, assetId));
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(lastError()).toContain("was created by someone else");
  expect(fake.requests).toHaveLength(1);
  await handle.db.update(schema.asset).set({ creatorPrincipalId: principalId }).where(eq(schema.asset.id, assetId));

  const { commitSha } = await assets.populateAsset({ assetId, ref: DEFAULT_ASSET_REF, tree: { files: { ...(await bundle.tree(INDEX.at(-1)!)), "index.ts": "export {};" }, message: "drift" }, principal: { kind: "hub" } });
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(lastError()).toContain(`holds ${commitSha}, which is not this release`);
  expect(fake.requests).toHaveLength(1);
}, 120_000);

test("PostgreSQL: twelve workspaces rolling at once leave the pool free for other queries", async () => {
  const gate = Promise.withResolvers<void>();
  let entered = 0;
  const lock = createWorkspaceLock(handle.db.$client);
  const rollout = {
    async roll(tenantId: string): Promise<RollOutcome> {
      const unlock = await lock(tenantId);
      if (!unlock) return { busy: true, failed: [] };
      try {
        entered += 1;
        await gate.promise;
        return SUCCEEDED;
      } finally {
        await unlock();
      }
    },
  };
  const queue = createRolloutQueue(rollout, { quietMs: 0, retryMs: 60_000, concurrency: 2, random: Math.random }, function ignore() {});
  const runs = Array.from({ length: 12 }, (_, index) => queue.run(`tnt_busy_${index}`));
  for (let waited = 0; entered < 2 && waited < 500; waited += 1) await Bun.sleep(10);
  async function poolAnswers(): Promise<unknown> {
    const [row] = await handle.db.execute(sql`select 1 as up`);
    return row;
  }
  expect(await Promise.race([poolAnswers(), Bun.sleep(5_000)])).toEqual({ up: 1 });
  expect(entered).toBe(2);
  gate.resolve();
  await Promise.all(runs);
  expect(entered).toBe(12);
}, 120_000);

test("a roll that finds the workspace held or fails keeps the hosts waiting to start again, and is tried again", async () => {
  const outcomes: RollOutcome[] = [{ busy: true, failed: [] }, FAILED, SUCCEEDED];
  const asked: Array<RepoSource[]> = [];
  const done = Promise.withResolvers<void>();
  const rollout = {
    async roll(_tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RollOutcome> {
      asked.push([...redeploy]);
      const outcome = outcomes.shift()!;
      if (outcomes.length === 0) done.resolve();
      return outcome;
    },
  };
  const retries: unknown[] = [];
  const queue = createRolloutQueue(rollout, { quietMs: 0, retryMs: 20, concurrency: 2, random: () => 1 }, function logged(entry) {
    if (entry["msg"] === "workflow_release_retry") retries.push(entry["inMs"]);
  });
  queue.request("tnt_retry", ["github", "bitbucket-datacenter"]);
  await done.promise;
  expect(asked).toEqual([["github", "bitbucket-datacenter"], ["github", "bitbucket-datacenter"], ["github"]]);
  expect(retries).toEqual([26, 26]);
});

test("PostgreSQL: a model key or catalog write starts every host's listener again, a host's own credential only that host's, and removing one as writing it", async () => {
  const { tenantId } = await workspace("writes");
  await handle.db.insert(schema.provider).values({ id: "prv_writes", tenantId, name: "anthropic", plugin: "http", apiBaseUrl: "https://models.test" });
  await handle.db.insert(schema.credential).values(["anthropic", "github-app", "bitbucket-datacenter-hook"].map((name) => ({ id: `crd_${name}`, tenantId, principalId: null, providerId: "prv_writes", oauthClientId: null, name, type: "api_key" as const, secret: "unused", status: "active" as const })));
  async function written(method: string, path: string, body?: unknown) {
    const req = new Request(`https://hub.test${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
    return (await releaseWriteOf(handle.db, req, path))?.redeploy;
  }
  const credentials = `/api/tenants/${tenantId}/credentials`;
  expect(await written("POST", credentials, { name: "anthropic" })).toEqual(REPO_SOURCES);
  expect(await written("POST", `/api/tenants/${tenantId}/catalog/models`, {})).toEqual(REPO_SOURCES);
  expect(await written("POST", credentials, { name: "github" })).toEqual(["github"]);
  for (const method of ["PATCH", "DELETE"]) {
    expect(await written(method, `${credentials}/crd_anthropic`)).toEqual(REPO_SOURCES);
    expect(await written(method, `${credentials}/crd_github-app`)).toEqual(["github"]);
    expect(await written(method, `${credentials}/crd_bitbucket-datacenter-hook`)).toEqual(["bitbucket-datacenter"]);
  }
  expect(await written("GET", credentials)).toBeUndefined();
}, 120_000);

test("a roll that fails while a request waits out its quiet window rolls again when that window ends, not after the retry", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const again = Promise.withResolvers<void>();
  let rolls = 0;
  const rollout = {
    async roll(): Promise<RollOutcome> {
      rolls += 1;
      if (rolls === 1) {
        entered.resolve();
        await gate.promise;
        return FAILED;
      }
      again.resolve();
      return SUCCEEDED;
    },
  };
  const queue = createRolloutQueue(rollout, { quietMs: 50, retryMs: 60_000, concurrency: 2, random: () => 0.5 }, function ignore() {});
  const first = queue.run("tnt_quiet");
  await entered.promise;
  queue.request("tnt_quiet", []);
  gate.resolve();
  await first;
  async function rolledAgain(): Promise<boolean> {
    await again.promise;
    return true;
  }
  expect(await Promise.race([rolledAgain(), Bun.sleep(2_000)])).toBe(true);
  expect(rolls).toBe(2);
});

test("a connected host found with no live listener rolls its workspace, and every host's listener stock gave up stopping is reported on every pass", async () => {
  const ensured: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const listeners: Partial<Record<RepoSource, { runId: string }>> = { "bitbucket-datacenter": { runId: "run_bitbucket" } };
  const watch = createListenerWatch({
    async connectedSources() {
      return ["github", "bitbucket-datacenter"];
    },
    async listener(_tenantId, source) {
      return listeners[source];
    },
    async stuck(_tenantId, source) {
      return source === "bitbucket-datacenter" ? ["run_stuck"] : [];
    },
    async allocation() {
      return undefined;
    },
    async routable() {
      return true;
    },
    ensure(tenantId) {
      ensured.push(tenantId);
    },
    replace() {
      return true;
    },
    log(entry) {
      logged.push(entry);
    },
  });
  await watch("tnt_watch");
  expect(ensured).toEqual(["tnt_watch"]);
  listeners.github = { runId: "run_github" };
  await watch("tnt_watch");
  expect(ensured).toEqual(["tnt_watch"]);
  const stuck = { level: "warn", msg: "listener_cancel_stuck", tenantId: "tnt_watch", source: "bitbucket-datacenter", deployment: "run_stuck" };
  expect(logged).toEqual([stuck, stuck]);
});

test("a listener whose connected sidecar the router holds no route to is started again once, and one whose sidecar is not connected is left to stock", async () => {
  const listeners: Record<RepoSource, { runId: string }> = { github: { runId: "run_github" }, "bitbucket-datacenter": { runId: "run_bitbucket" } };
  const routes: Record<string, () => boolean> = {
    alc_github: () => false,
    alc_bitbucket: () => {
      throw new Error("Allocation alc_bitbucket is not connected");
    },
  };
  const rolled: Array<RepoSource[]> = [];
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const rollout = {
    async roll(_tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RollOutcome> {
      rolled.push([...redeploy].sort());
      entered.resolve();
      await gate.promise;
      for (const source of redeploy) listeners[source] = { runId: `${listeners[source].runId}_next` };
      replaced.resolve();
      return SUCCEEDED;
    },
  };
  const logged: Record<string, unknown>[] = [];
  const queue = createRolloutQueue(rollout, { quietMs: 0, retryMs: 60_000, concurrency: 2, random: Math.random }, function ignore() {});
  const watch = createListenerWatch({
    async connectedSources() {
      return ["github", "bitbucket-datacenter"];
    },
    async listener(_tenantId, source) {
      return listeners[source];
    },
    async stuck() {
      return [];
    },
    async allocation(runId) {
      return runId.endsWith("_next") ? { allocationId: "alc_next", generation: 1 } : { allocationId: `alc_${runId.slice(4)}`, generation: 1 };
    },
    async routable(target) {
      return routes[target.allocationId]?.() ?? true;
    },
    ensure() {
      throw new Error("Every host has a listener.");
    },
    replace: queue.replace,
    log(entry) {
      logged.push(entry);
    },
  });
  await watch("tnt_unroutable");
  await watch("tnt_unroutable");
  await entered.promise;
  await watch("tnt_unroutable");
  gate.resolve();
  await replaced.promise;
  await Bun.sleep(10);
  await watch("tnt_unroutable");
  await Bun.sleep(10);
  expect(rolled).toEqual([["github"]]);
  const disconnected = { level: "debug", msg: "listener_disconnected", tenantId: "tnt_unroutable", source: "bitbucket-datacenter", deployment: "run_bitbucket", allocationId: "alc_bitbucket", generation: 1, reason: "Allocation alc_bitbucket is not connected" };
  expect(logged).toEqual([
    { level: "warn", msg: "listener_unroutable", tenantId: "tnt_unroutable", source: "github", deployment: "run_github", allocationId: "alc_github", generation: 1, reason: "its sidecar is connected but the hub holds no route to it" },
    disconnected,
    disconnected,
    disconnected,
    disconnected,
  ]);
});

test("PostgreSQL: a person keeps the Deployer role until a roll leaves every host's listener running", async () => {
  const { tenantId, principalId, fake, rollout } = await workspace("revoke");
  await rollout.roll(tenantId, NO_REDEPLOY);
  const [deployer] = await handle.db.select({ roleId: schema.principalRole.roleId }).from(schema.principalRole).where(eq(schema.principalRole.principalId, principalId));
  await handle.db.insert(schema.user).values({ id: "usr_revoke_admin", email: "admin@revoke.test", name: "Admin" });
  await handle.db.insert(schema.principal).values({ id: "prn_revoke_admin", tenantId, kind: "user", refId: "usr_revoke_admin", status: "active" });
  await handle.db.insert(schema.principalRole).values({ principalId: "prn_revoke_admin", roleId: deployer!.roleId });
  async function holders(): Promise<string[]> {
    const rows = await handle.db.select({ principalId: schema.principalRole.principalId }).from(schema.principalRole).where(eq(schema.principalRole.roleId, deployer!.roleId));
    return rows.map((row) => row.principalId).sort();
  }

  fake.starts = "ended";
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(FAILED);
  expect(await holders()).toEqual(["prn_revoke_admin", principalId].sort());

  fake.runs[0]!.state = "starting";
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(await holders()).toEqual(["prn_revoke_admin", principalId].sort());

  fake.starts = "live";
  expect(await rollout.roll(tenantId, REDEPLOY_GITHUB)).toEqual(SUCCEEDED);
  expect(await holders()).toEqual([principalId]);
}, 120_000);

test("PostgreSQL: a roll run again grants each chain asset's read once, and a writer without admin writes neither that grant nor a Deployer revoke", async () => {
  const { tenantId, principalId, fake, rollout } = await workspace("regrant");
  async function readGrants() {
    return handle.db.select({ id: schema.grant.id, resource: schema.grant.resource }).from(schema.grant)
      .where(and(eq(schema.grant.tenantId, tenantId), eq(schema.grant.principalId, principalId), like(schema.grant.resource, "asset:%"), eq(schema.grant.action, "read")));
  }
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  const granted = await readGrants();
  expect(granted).toHaveLength(2);
  expect(await rollout.roll(tenantId, NO_REDEPLOY)).toEqual(SUCCEEDED);
  expect(await readGrants()).toEqual(granted);

  const [deployer] = await handle.db.select({ roleId: schema.principalRole.roleId }).from(schema.principalRole).where(eq(schema.principalRole.principalId, principalId));
  await handle.db.insert(schema.user).values({ id: "usr_regrant_admin", email: "admin@regrant.test", name: "Admin" });
  await handle.db.insert(schema.principal).values({ id: "prn_regrant_admin", tenantId, kind: "user", refId: "usr_regrant_admin", status: "active" });
  await handle.db.insert(schema.principalRole).values({ principalId: "prn_regrant_admin", roleId: deployer!.roleId });
  const [writer] = await handle.db.select({ id: schema.principal.id }).from(schema.principal).where(and(eq(schema.principal.tenantId, tenantId), eq(schema.principal.refId, SYSTEM_WRITER)));
  await handle.db.delete(schema.principalRole).where(eq(schema.principalRole.principalId, writer!.id));
  await handle.db.delete(schema.grant).where(eq(schema.grant.id, granted[0]!.id));

  const deps = { db: handle.db, writes, assets, repoStore, now: () => new Date() };
  await expect(publishRelease(deps, { tenantId, principalId }, bundle, fake.models)).rejects.toThrow(SystemWriteDenied);
  expect(await readGrants()).toEqual(granted.slice(1));
  await expect(revokeHumanDeployers(writes, tenantId, (entry) => fake.logs.push(entry))).rejects.toThrow(SystemWriteDenied);
  const holders = await handle.db.select({ principalId: schema.principalRole.principalId }).from(schema.principalRole).where(eq(schema.principalRole.roleId, deployer!.roleId));
  expect(holders.map((row) => row.principalId).sort()).toEqual(["prn_regrant_admin", principalId].sort());
}, 120_000);
