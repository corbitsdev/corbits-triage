// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { createDB, createSidecarAllocationStore, runMigrations, schema } from "@intx/db";
import { generateKeyPair } from "@intx/crypto";
import {
  createAgentRepoStore,
  createParkedRunClassifier,
  createSidecarAllocationReconciler,
  createSidecarPluginRegistry,
  createWorkflowRunReader,
  type SidecarAllocationReconcilerDeps,
  type SidecarProvisioner,
} from "@intx/hub-sessions";
import { replaceUnstartedRuns, UNSTARTED_RUN_ATTEMPTS } from "./unstarted-run.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_unstarted";
const RUN = "run_review";
const ALLOCATION = "sal_review";
/** Stands in for the hub's two minutes to connect, and fifteen to reconnect, which a lost sandbox always misses. */
const DEADLINE_MS = 300;
/** Long enough that no deadline the reconciler set is what ends a test. */
const SETTLE_MS = 15_000;

type Db = ReturnType<typeof createDB>["db"];
type Router = SidecarAllocationReconcilerDeps["router"];
type Target = Parameters<Router["isAllocatedSidecarReady"]>[0];
type Allocation = typeof schema.sidecarAllocation.$inferSelect;

async function withDatabase(run: (db: Db, dataDir: string) => Promise<void>): Promise<void> {
  const database = `corbits_unstarted_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  const dataDir = await mkdtemp(join(tmpdir(), "corbits-unstarted-"));
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Unstarted", slug: "unstarted", domain: "unstarted.test" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_review", tenantId: TENANT, name: "code-review-github" });
    await handle.db.insert(schema.workflowRun).values({ id: RUN, anchorRunId: RUN, definitionId: "wfd_review", tenantId: TENANT, status: "deployed", address: `${RUN}@unstarted.test` });
    await handle.db.insert(schema.sidecarAllocation).values({
      id: ALLOCATION,
      anchorRunId: RUN,
      tenantId: TENANT,
      provisionerId: "railway-sandbox",
      provisionerApiVersion: 2,
      provisionerBindingFingerprint: "railway-sandbox:v1",
      adapterManifestDigest: "digest",
      status: "pending",
      maxDisconnectedMs: DEADLINE_MS,
    });
    await run(handle.db, dataDir);
  } finally {
    await handle?.close();
    await rm(dataDir, { recursive: true, force: true });
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

/**
 * Code review's placement through the hub's reconciler and allocation store: each sandbox the provisioner starts is
 * one generation, only the `connecting`-th one reaches the hub, and deploying the run records its public key as stock's
 * deploy does.
 */
async function placement(db: Db, dataDir: string, connecting: number) {
  const started: number[] = [];
  const deployed: number[] = [];
  let lost = false;
  const provisioner: SidecarProvisioner = {
    id: "railway-sandbox",
    apiVersion: 2,
    bindingFingerprint: "railway-sandbox:v1",
    capabilities: [{ capability: "isolation:workload", state: "available" }],
    async ensure({ generation }) {
      started.push(generation);
      return { kind: "accepted" };
    },
    async destroy() {
      return { kind: "destroyed", cleanup: "confirmed" };
    },
  };
  function connected({ generation }: Target): boolean {
    return !lost && started.indexOf(generation) === connecting - 1;
  }
  const router: Router = {
    fenceAllocation() {},
    retireAllocation() {},
    getCleanupConnection: () => undefined,
    holdsAllocatedBinding: connected,
    isAllocatedSidecarReady: async (target) => connected(target),
    reportedDeploymentFailure: () => undefined,
    syncSidecar: async () => undefined,
    undeployAllocation: async () => undefined,
    waitForSidecarInventory: async () => undefined,
    async waitForAllocatedSidecar(target) {
      if (!connected(target)) throw new Error(`Timed out waiting for allocated sidecar ${target.allocationId}`);
    },
  };
  async function run() {
    const row = await db.query.workflowRun.findFirst({ where: eq(schema.workflowRun.id, RUN) });
    if (row === undefined) throw new Error("the run is gone");
    return row;
  }
  async function publicKeyForAnchor(): Promise<string | null> {
    return (await run()).publicKey;
  }
  // Its repositories stay empty, as the hub's do for a run whose sandbox never reached it.
  const runReader = createWorkflowRunReader(createAgentRepoStore({ dataDir, signingKey: await generateKeyPair() }).repoStore);
  const reconciler = createSidecarAllocationReconciler({
    allocationStore: createSidecarAllocationStore(db, { getSidecarInventory: () => undefined }),
    plugins: createSidecarPluginRegistry({ provisioners: [provisioner] }),
    router,
    hubWebSocketUrl: "wss://hub.unstarted.test/ws/sidecar",
    connectTimeoutMs: DEADLINE_MS,
    classifyParkedRun: replaceUnstartedRuns({
      publicKeyForAnchor,
      stock: createParkedRunClassifier({ runReader, addressForAnchor: async () => `${RUN}@unstarted.test`, projectionForAnchor: async () => null }),
    }),
    async onReady(allocation) {
      deployed.push(allocation.generation);
      await db.update(schema.workflowRun).set({ publicKey: "deployed-key" }).where(eq(schema.workflowRun.id, RUN));
    },
  });
  await reconciler.initialize();

  async function allocation(): Promise<Allocation> {
    const row = await db.query.sidecarAllocation.findFirst({ where: eq(schema.sidecarAllocation.id, ALLOCATION) });
    if (row === undefined) throw new Error("the allocation is gone");
    return row;
  }
  const failuresMeanwhile: (string | null)[] = [];
  /** Whether the run was deployed on the allocation's current sandbox, or the allocation was released. */
  function placed({ status, generation }: Allocation): boolean {
    return status === "released" || deployed.includes(generation);
  }
  /** Reconciles until `done` holds, noting the run's failure on every round before. */
  async function settle(done: (row: Allocation) => boolean = placed) {
    const until = Date.now() + SETTLE_MS;
    while (Date.now() < until) {
      await reconciler.reconcileUntilIdle();
      if (done(await allocation())) break;
      failuresMeanwhile.push((await run()).failureCode);
      await Bun.sleep(100);
    }
    return { started, deployed, failuresMeanwhile, allocation: await allocation(), run: await run() };
  }
  async function loseSandbox(): Promise<void> {
    lost = true;
    const { generation } = await allocation();
    await reconciler.handleDisconnect({ allocationId: ALLOCATION, generation });
  }
  return { settle, loseSandbox };
}

test("a code review whose first sandbox never connects is deployed on a second one, and its run never fails", async () => {
  await withDatabase(async function replaced(db, dataDir) {
    const placed = await (await placement(db, dataDir, 2)).settle();

    expect(placed.started.length).toBe(2);
    expect(placed.deployed).toEqual([placed.started[1]!]);
    expect(placed.allocation.status).toBe("allocated");
    expect(placed.failuresMeanwhile.every((code) => code === null)).toBe(true);
    expect(placed.run.failureCode).toBeNull();
  });
}, 20_000);

test("a code review whose sandboxes never connect fails as it did before, once it has had its three", async () => {
  await withDatabase(async function released(db, dataDir) {
    const placed = await (await placement(db, dataDir, 0)).settle();

    expect(placed.started.length).toBe(UNSTARTED_RUN_ATTEMPTS);
    expect(placed.deployed).toEqual([]);
    expect(placed.allocation.status).toBe("released");
    expect(placed.run.failureCode).toBe("sidecar_connect_failed");
  });
}, 20_000);

test("a code review whose deployed sandbox is lost fails as it did before, and is not deployed again", async () => {
  await withDatabase(async function lostAfterDeploy(db, dataDir) {
    const play = await placement(db, dataDir, 1);
    await play.settle();
    await play.loseSandbox();
    const placed = await play.settle(({ status }) => status === "released");

    expect(placed.started.length).toBe(1);
    expect(placed.deployed.length).toBe(1);
    expect(placed.allocation.status).toBe("released");
    expect(placed.run.failureCode).toBe("sidecar_connect_failed");
  });
}, 20_000);
