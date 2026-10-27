// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import { createPlacementChooser, localSidecarUsage, WAITING_FOR_SLOT } from "./placement.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_placement";

type Db = ReturnType<typeof createDB>["db"];
type Status = typeof schema.sidecarAllocation.$inferInsert.status;

function provisioner(id: string): SidecarProvisioner {
  return {
    id,
    apiVersion: 2,
    bindingFingerprint: `${id}:v1`,
    capabilities: [],
    ensure() {
      throw new Error("Placement never ensures.");
    },
    destroy() {
      throw new Error("Placement never destroys.");
    },
  };
}

const local = provisioner("local-process");
const sandbox = provisioner("railway-sandbox");

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_placement_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Placement", slug: "placement", domain: "placement.test" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_manager", tenantId: TENANT, name: "triage-manager-github" });
    await handle.db.insert(schema.principal).values({ id: "prn_owner", tenantId: TENANT, kind: "user", refId: "usr_owner", status: "active" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

let next = 0;

async function deployed(db: Db, on: SidecarProvisioner, status: Status, { deploymentCleanupConfirmed = false, requires = [] as string[], failureCode = null as string | null } = {}): Promise<void> {
  const id = `run_${String(++next)}`;
  await db.insert(schema.workflowRun).values({ id, anchorRunId: id, definitionId: "wfd_manager", tenantId: TENANT, status: "running" });
  await db.insert(schema.workflowRunLaunchSpec).values({
    anchorRunId: id,
    sessionId: `ses_${String(next)}`,
    deploymentDomain: "placement.test",
    sourceAuthorityPrincipalId: "prn_owner",
    frozenApprovalBundle: { projection: { sidecarPlacement: { capabilities: requires.map((capability) => ({ capability, effect: "require" })) } } },
    sourceOfferingIds: [],
    defaultSourceOfferingId: "off_default",
    deployContent: {},
  });
  await db.insert(schema.sidecarAllocation).values({
    id: `sal_${String(next)}`,
    anchorRunId: id,
    tenantId: TENANT,
    provisionerId: on.id,
    provisionerApiVersion: 2,
    provisionerBindingFingerprint: on.bindingFingerprint,
    adapterManifestDigest: "digest",
    status,
    deploymentCleanupConfirmed,
    failureCode,
    maxDisconnectedMs: 60_000,
  });
}

async function probing(db: Db, on: SidecarProvisioner, status: typeof schema.workflowProbe.$inferInsert.status): Promise<void> {
  const id = `wpr_${String(++next)}`;
  await db.insert(schema.asset).values({ id: `ast_${id}`, tenantId: TENANT, kind: "workflow", name: id, creatorPrincipalId: "prn_owner" });
  await db.insert(schema.workflowProbe).values({
    id,
    tenantId: TENANT,
    definitionAssetId: `ast_${id}`,
    source: { kind: "asset", assetId: `ast_${id}`, package: { format: "source", commitSha: "0".repeat(40) } },
    entry: "index.ts",
    status,
    provisionerId: on.id,
    provisionerApiVersion: 2,
    provisionerBindingFingerprint: on.bindingFingerprint,
    adapterManifestDigest: "digest",
  });
}

test("a deployment goes to the local sidecar until its active slots are taken, then to the first sandbox, which counts as overflow", async () => {
  await withDatabase(async function place(db) {
    const choose = createPlacementChooser({ db, local, maxDeployments: 2 });
    await deployed(db, local, "allocated");
    await deployed(db, local, "released", { deploymentCleanupConfirmed: true });
    await deployed(db, local, "releasing", { deploymentCleanupConfirmed: true });
    await deployed(db, sandbox, "allocated");
    await deployed(db, sandbox, "allocated", { requires: ["isolation:workload"] });
    expect(await choose([local, sandbox])).toBe(local);

    // A copy the sidecar has not confirmed removing still holds its slot.
    await deployed(db, local, "releasing");
    expect(await choose([local, sandbox])).toBe(sandbox);
    expect(await choose([local])).toBe(local);
    expect(await choose([sandbox])).toBe(sandbox);

    // Only the sandbox deployment that could have run locally overflowed; the one that requires isolation did not.
    expect(await localSidecarUsage(db, local, 2)).toEqual({ active: 2, waiting: 0, cap: 2, overflow: 1 });
  });
}, 120_000);

test("placements side by side cannot both take the local sidecar's last slot, which frees once its pick is counted", async () => {
  await withDatabase(async function race(db) {
    let clock = 0;
    const choose = createPlacementChooser({ db, local, maxDeployments: 2, now: () => clock });
    await deployed(db, local, "allocated");

    const picks = await Promise.all([choose([local, sandbox]), choose([local, sandbox]), choose([local, sandbox])]);
    expect(picks).toEqual([local, sandbox, sandbox]);

    clock += 31_000;
    expect(await choose([local, sandbox])).toBe(local);
  });
}, 120_000);

test("probes on the local sidecar take its slots, and placements waiting there for one are counted apart and still fill it", async () => {
  await withDatabase(async function shared(db) {
    const choose = createPlacementChooser({ db, local, maxDeployments: 3 });
    await deployed(db, local, "allocated");
    await probing(db, local, "probing");
    await probing(db, local, "failed");
    await probing(db, sandbox, "probing");
    expect(await localSidecarUsage(db, local, 3)).toEqual({ active: 2, waiting: 0, cap: 3, overflow: 0 });

    await deployed(db, local, "provisioning", { failureCode: WAITING_FOR_SLOT });
    await deployed(db, local, "failed", { failureCode: WAITING_FOR_SLOT });
    expect(await localSidecarUsage(db, local, 3)).toEqual({ active: 2, waiting: 1, cap: 3, overflow: 0 });
    expect(await choose([local, sandbox])).toBe(sandbox);
  });
}, 120_000);
