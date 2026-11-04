// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { createEnvKeyCredentialCipher, generateKeyPair } from "@intx/crypto";
import { createDB, createGrantStore, createPrincipalKeyStore, runMigrations, schema } from "@intx/db";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import {
  createAgentRepoStore,
  createAssetService,
  DEFAULT_ASSET_REF,
  dequeueToProcessing,
  enqueueInbox,
  markConsumed,
  SidecarNotConnectedError,
  workflowRunRepoIdForAddress,
  type AssetService,
  type RepoStore,
} from "@intx/hub-sessions";
import { DEPLOYER_GRANTS, type ModelInfo, type RepoSource, type SourceIndexEntry } from "@corbits/triage-contracts";
import { createSystemWrites, type SystemWrites } from "../system-writes/writer.js";
import type { Bundle } from "./publish.js";
import { setUpPublisher } from "./publisher.js";
import { createWorkspaceLock } from "./reads.js";
import { createListenerWatch, LISTENER_STALL_MS, listenerBacklog } from "./triggers.js";
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

type Run = Deployment & { workflow: string; state: DeployState };

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
      fake.runs.push({ runId, workflow: LISTENER, state: fake.starts, createdAt: new Date(fake.clock + fake.requests.length), cancelling: false, source: { assetId: request.assetId, commitSha: request.commitSha } });
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
      const run = fake.runs.find((row) => row.runId === runId);
      if (!run) return null;
      return {
        status: run.cancelling ? "cancelled" : "running",
        allocation: { id: `alc_${runId}`, generation: 1, status: "allocated", failureCode: null, failureMessage: null },
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
  const release = (await managerRelease(manager.id)).github;
  expect(Object.keys(release).sort()).toEqual(["codeReviews", "judge"]);
  const reviewer = withReview.find((row) => row.name.startsWith("pr-code-review-reviewer-github"))!;
  expect(release.codeReviews).toEqual({
    "pr-code-review-reviewer-github": expect.objectContaining({
      name: "pr-code-review-reviewer-github",
      workflow: expect.objectContaining({ assetId: reviewer.id }),
    }),
  });
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

test("a listener whose sidecar stays disconnected past its limit is replaced once, and a second watch during that roll does not start another", async () => {
  const limit = 15 * 60_000;
  let clock = 0;
  let away = true;
  const listeners = { github: { runId: "run_github" } };
  const rolled: Array<RepoSource[]> = [];
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const rollout = {
    async roll(_tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RollOutcome> {
      rolled.push([...redeploy].sort());
      entered.resolve();
      await gate.promise;
      listeners.github = { runId: "run_github_next" };
      away = false;
      replaced.resolve();
      return SUCCEEDED;
    },
  };
  const logged: Record<string, unknown>[] = [];
  const queue = createRolloutQueue(rollout, { quietMs: 0, retryMs: 60_000, concurrency: 2, random: Math.random }, function ignore() {});
  const watch = createListenerWatch({
    async connectedSources() {
      return ["github"];
    },
    async listener() {
      return listeners.github;
    },
    async stuck() {
      return [];
    },
    async allocation(runId) {
      return { allocationId: runId === "run_github" ? "alc_github" : "alc_next", generation: 1, maxDisconnectedMs: limit };
    },
    async routable() {
      if (away) throw new SidecarNotConnectedError("Allocation alc_github is not connected", new Date(0));
      return true;
    },
    async backlog() {
      return undefined;
    },
    ensure() {
      throw new Error("The host has a listener.");
    },
    replace: queue.replace,
    now() {
      return new Date(clock);
    },
    log(entry) {
      logged.push(entry);
    },
  });
  clock = limit;
  await watch("tnt_away");
  expect(rolled).toEqual([]);
  clock = limit + 1;
  await watch("tnt_away");
  await entered.promise;
  await watch("tnt_away");
  expect(rolled).toEqual([["github"]]);
  gate.resolve();
  await replaced.promise;
  await Bun.sleep(10);
  await watch("tnt_away");
  await Bun.sleep(10);
  expect(rolled).toEqual([["github"]]);
  const entry = { tenantId: "tnt_away", source: "github", deployment: "run_github", allocationId: "alc_github", generation: 1 };
  expect(logged).toEqual([
    { level: "debug", msg: "listener_disconnected", ...entry, reason: "Allocation alc_github is not connected" },
    { level: "warn", msg: "listener_unreachable", ...entry, unreachableMs: limit + 1, reason: "its sidecar stayed disconnected longer than the deployment's limit" },
  ]);
});

test("PostgreSQL: a routable listener whose oldest inbox or processing mail waited past the stall limit is replaced once, and a failed backlog read is only logged", async () => {
  const { tenantId } = await workspace("stalled");
  const runId = "run_stalled_github";
  const address = `${runId}@stalled.test`;
  const repoId = workflowRunRepoIdForAddress(address);
  const supervisor = { kind: "supervisor" as const, anchorRunId: repoId.id };
  await handle.db.insert(schema.workflowDefinition).values({ id: "wdf_stalled", tenantId, name: LISTENER });
  await handle.db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wdf_stalled", tenantId, address, status: "running" });

  expect(await listenerBacklog(handle.db, repoStore, runId)).toBeUndefined();
  await enqueueInbox(repoStore, supervisor, repoId, { address, messageId: "msg_1", receivedAt: 2_000, mailAuditRef: { store: "s", path: "1" } });
  await enqueueInbox(repoStore, supervisor, repoId, { address, messageId: "msg_2", receivedAt: 5_000, mailAuditRef: { store: "s", path: "2" } });
  expect(await listenerBacklog(handle.db, repoStore, runId)).toEqual(new Date(2_000));
  await dequeueToProcessing(repoStore, supervisor, repoId, address);
  expect(await listenerBacklog(handle.db, repoStore, runId)).toEqual(new Date(2_000));

  let clock = 2_000 + LISTENER_STALL_MS - 1;
  let readFails = false;
  const listeners = { github: { runId } };
  const rolled: Array<RepoSource[]> = [];
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const replaced = Promise.withResolvers<void>();
  const rollout = {
    async roll(_tenantId: string, redeploy: ReadonlySet<RepoSource>): Promise<RollOutcome> {
      rolled.push([...redeploy].sort());
      entered.resolve();
      await gate.promise;
      listeners.github = { runId: "run_stalled_next" };
      replaced.resolve();
      return SUCCEEDED;
    },
  };
  const logged: Record<string, unknown>[] = [];
  const queue = createRolloutQueue(rollout, { quietMs: 0, retryMs: 60_000, concurrency: 2, random: Math.random }, function ignore() {});
  const watch = createListenerWatch({
    async connectedSources() {
      return ["github"];
    },
    async listener() {
      return listeners.github;
    },
    async stuck() {
      return [];
    },
    async allocation(id) {
      return { allocationId: id === runId ? "alc_github" : "alc_next", generation: 1, maxDisconnectedMs: 15 * 60_000 };
    },
    async routable() {
      return true;
    },
    async backlog(id) {
      if (readFails) throw new Error("repo read failed");
      return listenerBacklog(handle.db, repoStore, id);
    },
    ensure() {
      throw new Error("The host has a listener.");
    },
    replace: queue.replace,
    now() {
      return new Date(clock);
    },
    log(entry) {
      logged.push(entry);
    },
  });

  await watch(tenantId);
  clock = 2_000 + LISTENER_STALL_MS;
  await watch(tenantId);
  expect(rolled).toEqual([]);

  clock = 2_000 + LISTENER_STALL_MS + 1;
  readFails = true;
  await watch(tenantId);
  expect(rolled).toEqual([]);

  readFails = false;
  await watch(tenantId);
  await entered.promise;
  await watch(tenantId);
  expect(rolled).toEqual([["github"]]);

  await markConsumed(repoStore, supervisor, repoId, { address, messageId: "msg_1", runId, consumedAt: clock, retentionHorizonMs: 60_000 });
  expect(await listenerBacklog(handle.db, repoStore, runId)).toEqual(new Date(5_000));
  await dequeueToProcessing(repoStore, supervisor, repoId, address);
  await markConsumed(repoStore, supervisor, repoId, { address, messageId: "msg_2", runId, consumedAt: clock, retentionHorizonMs: 60_000 });
  expect(await listenerBacklog(handle.db, repoStore, runId)).toBeUndefined();

  gate.resolve();
  await replaced.promise;
  await Bun.sleep(10);
  await watch(tenantId);
  await Bun.sleep(10);
  expect(rolled).toEqual([["github"]]);
  const entry = { tenantId, source: "github", deployment: runId, allocationId: "alc_github", generation: 1 };
  expect(logged).toEqual([
    { level: "warn", msg: "listener_check_failed", ...entry, reason: "repo read failed" },
    { level: "warn", msg: "listener_dispatch_stalled", ...entry, backlogMs: LISTENER_STALL_MS + 1 },
  ]);
}, 120_000);

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
