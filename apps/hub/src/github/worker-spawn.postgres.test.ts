// Requires PostgreSQL at TEST_DB. A triage job through the coordinator and the
// real worker spawner: a missing listener and a provisioner's capacity decline
// defer the job, a worker still starting is polled until it takes its mail, and
// under the hub's lifecycle policy the stock sweep releases a finished worker's
// sidecar as soon as its run ends.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, createWorkflowRunLaunchSpecStore, runMigrations, schema, type DB } from "@intx/db";
import { createWorkflowHistoryReceiveTracker, createWorkflowLifecycleService, WorkflowProvisioningError } from "@intx/hub-sessions";
import type { ResolvedWorkflowLifecyclePolicy } from "@intx/types";
import { interchangeSettings, type HubEnv } from "../env.js";
import { CAPACITY_UNAVAILABLE } from "../sidecar/host-capacity.js";
import { createCoordinator, type TriageJob } from "./coordinator.js";
import { DeploymentNotReadyError } from "./deployment.js";
import { createWorkerSpawner } from "./worker-spawn.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_spawn";
const DOMAIN = "spawn.test";
const WORKFLOW = "pr-triage";
const BUNDLE = {
  source: { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-workflow" } },
  entry: "./pr-triage.mjs",
  projection: { id: WORKFLOW, stepOrder: ["a"], steps: { a: { kind: "step", id: "a" } }, triggers: [] },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
  approvedWireHash: "deadbeef",
  approvedGrants: [],
};
const JOB: TriageJob = { tenantId: TENANT, workflow: WORKFLOW, repo: "acme/widgets", number: 8, headSha: "abc123", source: "event", payload: { prNumber: 8 } };

async function until(done: () => boolean): Promise<void> {
  while (!done()) await Bun.sleep(5);
}

async function withDatabase(body: (db: DB["db"]) => Promise<void>): Promise<void> {
  const database = `corbits_spawn_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const { db } = handle;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Spawn", slug: "spawn", domain: DOMAIN, config: {} });
    await db.insert(schema.principal).values({ id: "prn_deployer", tenantId: TENANT, kind: "user", refId: "deployer", status: "active" });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: WORKFLOW });
    await body(db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

async function deployWorker(db: DB["db"], content: Record<string, unknown>, lifecyclePolicy?: ResolvedWorkflowLifecyclePolicy): Promise<void> {
  await db.insert(schema.workflowRun).values({ id: "run_worker", anchorRunId: "run_worker", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed", lifecyclePolicy });
  await createWorkflowRunLaunchSpecStore(db).create({
    anchorRunId: "run_worker",
    sessionId: "ses_worker",
    deploymentDomain: DOMAIN,
    sourceAuthorityPrincipalId: "prn_deployer",
    frozenApprovalBundle: BUNDLE,
    sourceOfferingIds: ["off_a"],
    defaultSourceOfferingId: "off_a",
    deployContent: { systemPrompt: "Triage pull requests.", ...content },
  });
}

function notReached(): never {
  throw new Error("only reached with pending history or a live sidecar");
}

test("PostgreSQL: a job with no listener to copy, then refused for capacity, is deferred both times and its worker is fired once it starts", async () => {
  await withDatabase(async function deferThenFire(db) {
    const timers: Array<() => Promise<void>> = [];
    const delivered: string[] = [];
    const failed: string[] = [];
    const released: string[] = [];
    let refusals = 1;
    let notReady = 1;
    const coordinator = createCoordinator({
      spawner: createWorkerSpawner({
        db,
        async redeploy(_tenantId, _seed, content) {
          if (refusals-- > 0) throw new WorkflowProvisioningError(CAPACITY_UNAVAILABLE, "424 MiB free, 512 MiB needed");
          await deployWorker(db, content);
          return { status: "deployed", runId: "run_worker" };
        },
        async deliver(_tenantId, address) {
          if (notReady-- > 0) throw new DeploymentNotReadyError();
          delivered.push(address);
        },
        lifecycle: {
          async requestCancellation(_tenantId, runId) {
            released.push(runId);
            return "pending";
          },
          getStatus: async () => null,
        },
        sleep: () => Bun.sleep(1),
        fireTimeoutMs: 60_000,
        pollMs: 1,
      }),
      retry: { minMs: 1, maxMs: 1 },
      async failed(job, error) {
        failed.push(`${job.number}: ${error}`);
      },
      setTimer(fire) {
        timers.push(fire);
        return () => {};
      },
      now: () => new Date(),
      log: () => {},
    });

    coordinator.enqueue(JOB);
    await until(() => timers.length === 1);
    expect(coordinator.snapshot(TENANT).queued).toHaveLength(1);

    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed" });
    await timers.shift()!();
    await until(() => timers.length === 1);
    expect(refusals).toBe(0);

    await timers.shift()!();
    await until(() => released.length === 1);
    expect(delivered).toEqual([`run_worker@${DOMAIN}`]);
    expect(released).toEqual(["run_worker"]);
    expect(failed).toEqual([]);
    coordinator.stop();
  });
}, 120_000);

test("PostgreSQL: under the hub's lifecycle policy, a worker's sidecar is released as soon as its run ends", async () => {
  await withDatabase(async function releaseOnEnd(db) {
    const { defaultLifecyclePolicy } = interchangeSettings({ PORT: "0", HUB_DATA_DIR: "unused", PRINCIPAL_KEY_ENCRYPTION_KEY: "0".repeat(64) } as HubEnv);
    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed" });
    const lifecycle = createWorkflowLifecycleService({
      db,
      retentionRouter: {
        getRetentionCandidates: () => [],
        fenceAllocation() {},
        retainAllocation: notReached,
        getAllocationRetention: notReached,
        holdsAllocatedBinding: notReached,
        retireAllocation: notReached,
      },
      runReader: {
        listRunIds: notReached,
        readRunEvents: notReached,
        readLatestRunEvents: notReached,
        resolveRefTip: notReached,
        hasRepository: notReached,
      },
      historyReceives: createWorkflowHistoryReceiveTracker(),
    });
    const errors: Array<Record<string, unknown>> = [];
    const coordinator = createCoordinator({
      spawner: createWorkerSpawner({
        db,
        async redeploy(_tenantId, _seed, content) {
          await deployWorker(db, content, defaultLifecyclePolicy);
          await db.insert(schema.sidecarAllocation).values({
            id: "alc_worker",
            anchorRunId: "run_worker",
            tenantId: TENANT,
            provisionerId: "docker",
            provisionerApiVersion: 2,
            provisionerBindingFingerprint: "fp",
            adapterManifestDigest: "digest",
            status: "allocated",
            maxDisconnectedMs: 60_000,
          });
          return { status: "deployed", runId: "run_worker" };
        },
        async deliver() {
          await db.insert(schema.workflowRun).values({ id: "run_body", anchorRunId: "run_worker", definitionId: "wfd_triage", tenantId: TENANT, status: "completed" });
        },
        lifecycle,
        sleep: () => Bun.sleep(5),
        fireTimeoutMs: 60_000,
        pollMs: 5,
      }),
      retry: { minMs: 1, maxMs: 1 },
      failed: async () => {},
      setTimer: () => () => {},
      now: () => new Date(),
      log: (entry) => entry.level === "error" && errors.push(entry),
    });

    coordinator.enqueue(JOB);
    while ((await workerRun(db)).cancellationRequestedAt === null) await Bun.sleep(5);
    // Stock stops the idle anchor once its cancel grace runs out.
    const endedAt = Date.now();
    await db.update(schema.workflowRun).set({ status: "cancelled", endedAt: new Date(endedAt) }).where(eq(schema.workflowRun.id, "run_worker"));
    let allocation = await workerAllocation(db);
    while (allocation.status === "allocated" && Date.now() - endedAt < 1_000) {
      await lifecycle.reconcileNext();
      allocation = await workerAllocation(db);
    }
    expect(allocation.status).toBe("releasing");
    expect(errors).toEqual([]);
    coordinator.stop();
  });
}, 120_000);

async function workerRun(db: DB["db"]): Promise<typeof schema.workflowRun.$inferSelect> {
  const [run] = await db.select().from(schema.workflowRun).where(eq(schema.workflowRun.id, "run_worker"));
  if (!run) throw new Error("worker run missing");
  return run;
}

async function workerAllocation(db: DB["db"]): Promise<typeof schema.sidecarAllocation.$inferSelect> {
  const [allocation] = await db.select().from(schema.sidecarAllocation).where(eq(schema.sidecarAllocation.id, "alc_worker"));
  if (!allocation) throw new Error("worker allocation missing");
  return allocation;
}
