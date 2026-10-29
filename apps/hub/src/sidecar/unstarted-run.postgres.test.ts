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
/** Stands in for the hub's two minutes, which a sandbox that never connects always misses. */
const CONNECT_TIMEOUT_MS = 300;
/** Long enough that a deadline the reconciler set is never what ends a test. */
const SETTLE_MS = 15_000;

type Db = ReturnType<typeof createDB>["db"];
type Router = SidecarAllocationReconcilerDeps["router"];
type Target = Parameters<Router["isAllocatedSidecarReady"]>[0];

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
      maxDisconnectedMs: 60_000,
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
 * Plays code review's placement with the hub's reconciler and allocation store: each sandbox the provisioner starts is
 * one generation, and only the `connecting`-th one ever reaches the hub.
 */
async function playPlacement(db: Db, dataDir: string, connecting: number) {
  const started: number[] = [];
  const startedAt: number[] = [];
  const deployed: number[] = [];
  const provisioner: SidecarProvisioner = {
    id: "railway-sandbox",
    apiVersion: 2,
    bindingFingerprint: "railway-sandbox:v1",
    capabilities: [{ capability: "isolation:workload", state: "available" }],
    async ensure({ generation }) {
      started.push(generation);
      startedAt.push(Date.now());
      return { kind: "accepted" };
    },
    async destroy() {
      return { kind: "destroyed", cleanup: "confirmed" };
    },
  };
  function connected({ generation }: Target): boolean {
    return started.indexOf(generation) === connecting - 1;
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
  const runReader = createWorkflowRunReader(createAgentRepoStore({ dataDir, signingKey: await generateKeyPair() }).repoStore);
  async function addressForAnchor(anchorRunId: string): Promise<string | null> {
    const row = await db.query.workflowRun.findFirst({ where: eq(schema.workflowRun.id, anchorRunId), columns: { address: true } });
    return row?.address ?? null;
  }
  const reconciler = createSidecarAllocationReconciler({
    allocationStore: createSidecarAllocationStore(db, { getSidecarInventory: () => undefined }),
    plugins: createSidecarPluginRegistry({ provisioners: [provisioner] }),
    router,
    hubWebSocketUrl: "wss://hub.unstarted.test/ws/sidecar",
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    classifyParkedRun: replaceUnstartedRuns({ runReader, addressForAnchor, stock: createParkedRunClassifier({ runReader, addressForAnchor, projectionForAnchor: async () => null }) }),
    async onReady(allocation) {
      deployed.push(allocation.generation);
    },
  });
  await reconciler.initialize();

  async function allocation() {
    const row = await db.query.sidecarAllocation.findFirst({ where: eq(schema.sidecarAllocation.id, ALLOCATION) });
    if (row === undefined) throw new Error("the allocation is gone");
    return row;
  }
  async function run() {
    const row = await db.query.workflowRun.findFirst({ where: eq(schema.workflowRun.id, RUN) });
    if (row === undefined) throw new Error("the run is gone");
    return row;
  }
  const failuresMeanwhile: (string | null)[] = [];
  const until = Date.now() + SETTLE_MS;
  while (Date.now() < until) {
    await reconciler.reconcileUntilIdle();
    const { status } = await allocation();
    if (status === "released" || (status === "allocated" && deployed.length > 0)) break;
    failuresMeanwhile.push((await run()).failureCode);
    await Bun.sleep(100);
  }
  return { started, startedAt, deployed, failuresMeanwhile, allocation: await allocation(), run: await run() };
}

test("a code review whose first sandbox never connects gets a new one, after stock's backoff, and its run starts there", async () => {
  await withDatabase(async function replaced(db, dataDir) {
    const placed = await playPlacement(db, dataDir, 2);

    expect(placed.started.length).toBe(2);
    // Stock's first replacement waits a second after the missed deadline.
    expect(placed.startedAt[1]! - placed.startedAt[0]!).toBeGreaterThanOrEqual(CONNECT_TIMEOUT_MS + 1_000);
    expect(placed.deployed).toEqual([placed.started[1]!]);
    expect(placed.allocation.status).toBe("allocated");
    expect(placed.failuresMeanwhile.every((code) => code === null)).toBe(true);
    expect(placed.run.failureCode).toBeNull();
  });
}, 20_000);

test("a code review whose sandboxes never connect fails as it did before, once it has had its three", async () => {
  await withDatabase(async function released(db, dataDir) {
    const placed = await playPlacement(db, dataDir, 0);

    expect(placed.started.length).toBe(UNSTARTED_RUN_ATTEMPTS);
    expect(placed.deployed).toEqual([]);
    expect(placed.allocation.status).toBe("released");
    expect(placed.run.failureCode).toBe("sidecar_connect_failed");
  });
}, 20_000);
