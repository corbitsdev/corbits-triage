// Requires PostgreSQL at TEST_DB. The intake against a real store and a stand-in manager: the deploy and the mail are
// recorded instead of reaching a sidecar.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createDB, createWorkflowRunLaunchSpecStore, runMigrations, schema } from "@intx/db";
import { emptyPack } from "@corbits/triage-contracts";
import { triageWorkflowFor } from "./github/source-workflow.js";
import { createManagerIntake, ManagerUnavailableError, type ManagerDefinition } from "./manager-intake.js";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "./manager-routes.js";
import type { IntakeEvent, PullRequestRef } from "./manager-state.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_intake";
const DOMAIN = "intake.test";
const PR: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const CLAIM = "mgr:github:acme/widgets#7";
const MANAGER: ManagerDefinition = { assetName: "triage-manager-github", entry: "./triage-manager-github.mjs", pin: "@corbits/triage-manager-github-workflow@0.0.1" };
const LISTENER_BUNDLE = {
  source: { kind: "asset", assetId: "ast_registry", package: { format: "tarball" } },
  entry: "./pr-triage-github.mjs",
  projection: { id: "pr-triage-github", stepOrder: ["a"], steps: { a: { kind: "step", id: "a" } }, triggers: [] },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
  approvedWireHash: "deadbeef",
  approvedGrants: [],
};

type Db = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_intake_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const { db } = handle;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values({ id: TENANT, name: "Intake", slug: "intake", domain: DOMAIN, config: { corbitsTriage: { repos: [{ name: PR.repo, connected: true, enabled: true }] } } });
    await db.insert(schema.principal).values([
      { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "admin", status: "active" },
      { id: "prn_publisher", tenantId: TENANT, kind: "user", refId: "publisher", status: "active" },
    ]);
    await db.insert(schema.asset).values([
      { id: "ast_registry", tenantId: TENANT, kind: "package-registry", name: "corbits", creatorPrincipalId: "prn_admin" },
      { id: "ast_manager", tenantId: TENANT, kind: "workflow", name: MANAGER.assetName, creatorPrincipalId: "prn_publisher" },
    ]);
    const triage = triageWorkflowFor("github").id;
    await db.insert(schema.workflowDefinition).values([{ id: "wfd_triage", tenantId: TENANT, name: triage }, { id: "wfd_manager", tenantId: TENANT, name: MANAGER.assetName }]);
    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, status: "running" });
    await createWorkflowRunLaunchSpecStore(db).create({
      anchorRunId: "run_listener",
      sessionId: "ses_listener",
      deploymentDomain: DOMAIN,
      sourceAuthorityPrincipalId: "prn_admin",
      frozenApprovalBundle: LISTENER_BUNDLE,
      sourceOfferingIds: ["off_a"],
      defaultSourceOfferingId: "off_a",
      deployContent: { systemPrompt: "" },
    });
    await run(db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

type Deployed = { runId: string; entry: string; pin: string | undefined; definitionAssetId: string; deployer: string; registry: string };
type Mailed = { address: string; payload: unknown };

function stack(db: Db, managers: Partial<Record<PullRequestRef["source"], ManagerDefinition>> = { github: MANAGER }) {
  const deployed: Deployed[] = [];
  const mailed: Mailed[] = [];
  const refusing = new Set<string>();
  const intake = createManagerIntake({
    db,
    allocation: {
      async prepareProvisionedDeployment(args) {
        const runId = `run_manager_${deployed.length + 1}`;
        if (args.source.kind !== "asset") throw new Error("expected the registry");
        await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, status: "deployed" });
        deployed.push({ runId, entry: args.entry, pin: args.pin, definitionAssetId: args.definitionAssetId, deployer: args.sourceAuthorityPrincipalId, registry: args.source.assetId });
        return { anchorRunId: runId, deploymentAddress: `${runId}@${DOMAIN}`, allocationId: `alc_${runId}`, status: "pending" };
      },
    },
    launchSpecs: createWorkflowRunLaunchSpecStore(db),
    managers,
    readCheckPack: async () => ({ status: "ok", pack: emptyPack(PR.repo), automatic: [], source: { repo: { id: "art_pack", version: 1 } } }),
    async deliver(_tenantId, address, payload) {
      if (refusing.has(address)) throw new Error("the run has ended");
      mailed.push({ address, payload });
    },
    firstMail: { sleep: () => Bun.sleep(1), pollMs: 1, timeoutMs: 1_000 },
    now: () => new Date(),
  });
  return { intake, deployed, mailed, refusing };
}

function webhook(head: string): IntakeEvent {
  return { type: "webhook", head, payload: { action: "synchronize" } };
}

function reviewerResult(head: string): IntakeEvent {
  return { type: "reviewer-result", head, payload: { verdict: "pass" } };
}

async function claimOf(db: Db): Promise<Record<string, unknown>> {
  const [row] = await db.execute<{ state: Record<string, unknown> }>(sql`SELECT state FROM corbits_triage.manager_state WHERE key = ${CLAIM}`);
  return row.state;
}

test("PostgreSQL: two simultaneous intakes deploy one manager as the listener's deployer, grant its creator and mail it the trigger", async () => {
  await withDatabase(async function once(db) {
    const { intake, deployed, mailed } = stack(db);
    expect(await Promise.all([intake(TENANT, PR, "d1", webhook("h1")), intake(TENANT, PR, "d2", webhook("h1"))])).toEqual([{ recorded: true }, { recorded: true }]);

    expect(deployed).toEqual([{ runId: "run_manager_1", entry: MANAGER.entry, pin: MANAGER.pin, definitionAssetId: "ast_manager", deployer: "prn_admin", registry: "ast_registry" }]);
    expect(await claimOf(db)).toMatchObject({ status: "live", runId: "run_manager_1", starts: 1 });
    expect(mailed[0]).toMatchObject({ address: `run_manager_1@${DOMAIN}`, payload: { kind: "pr", repo: PR.repo, prNumber: 7, headSha: "h1" } });
    const granted = await db.select({ origin: schema.grant.origin }).from(schema.grant)
      .where(and(eq(schema.grant.principalId, "prn_publisher"), eq(schema.grant.resource, MANAGER_STATE_RESOURCE), eq(schema.grant.action, MANAGER_STATE_ACTION), eq(schema.grant.effect, "allow")));
    expect(granted).toEqual([{ origin: "creator" }]);
  });
}, 60_000);

test("PostgreSQL: a live manager is nudged, and one whose run has gone is replaced", async () => {
  await withDatabase(async function nudged(db) {
    const { intake, deployed, mailed, refusing } = stack(db);
    await intake(TENANT, PR, "d1", webhook("h1"));
    await intake(TENANT, PR, "d2", webhook("h2"));
    expect(deployed).toHaveLength(1);
    expect(mailed.map((mail) => mail.address)).toEqual([`run_manager_1@${DOMAIN}`, `run_manager_1@${DOMAIN}`]);
    expect(mailed[1]).toMatchObject({ payload: { headSha: "h2" } });

    await db.update(schema.workflowRun).set({ status: "completed" }).where(eq(schema.workflowRun.id, "run_manager_1"));
    refusing.add(`run_manager_1@${DOMAIN}`);
    await intake(TENANT, PR, "d3", webhook("h3"));
    expect(deployed.map((row) => row.runId)).toEqual(["run_manager_1", "run_manager_2"]);
    expect(mailed.at(-1)).toMatchObject({ address: `run_manager_2@${DOMAIN}`, payload: { headSha: "h3" } });
    expect(await claimOf(db)).toMatchObject({ status: "live", runId: "run_manager_2", starts: 2 });
  });
}, 60_000);

test("PostgreSQL: a reviewer result starts a manager when none is live and nudges the live one", async () => {
  await withDatabase(async function reviewer(db) {
    const { intake, deployed, mailed } = stack(db);
    await intake(TENANT, PR, "run_judge", reviewerResult("h1"));
    await intake(TENANT, PR, "run_review", reviewerResult("h1"));
    expect(deployed).toHaveLength(1);
    expect(mailed.map((mail) => mail.address)).toEqual([`run_manager_1@${DOMAIN}`, `run_manager_1@${DOMAIN}`]);
  });
}, 60_000);

test("PostgreSQL: with no manager published the event is recorded and no claim is left starting", async () => {
  await withDatabase(async function unavailable(db) {
    const { intake, deployed } = stack(db, {});
    await expect(intake(TENANT, PR, "d1", webhook("h1"))).rejects.toBeInstanceOf(ManagerUnavailableError);
    const [{ claims, events }] = await db.execute<{ claims: number; events: number }>(sql`SELECT count(*) FILTER (WHERE kind = 'claim')::int AS claims, count(*) FILTER (WHERE kind = 'event')::int AS events FROM corbits_triage.manager_state`);
    expect({ claims, events, deployed: deployed.length }).toEqual({ claims: 0, events: 1, deployed: 0 });
  });
}, 60_000);
