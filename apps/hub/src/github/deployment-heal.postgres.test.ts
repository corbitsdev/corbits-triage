// Requires PostgreSQL at TEST_DB. A pr-triage deployment Interchange failed,
// redeployed by the reconciler from its stored launch spec.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, createWorkflowRunLaunchSpecStore, runMigrations, schema } from "@intx/db";
import type { PrepareProvisionedWorkflowDeploymentArgs, WorkflowAllocationService, WorkflowLifecycleService } from "@intx/hub-sessions";
import { checkPackName, type CheckPack, type PrTriageRow } from "@corbits/triage-contracts";
import { createDeploymentRotation, latestDeployments, resolveLiveDeployments } from "./deployment.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import { createTriageReconciler } from "./triage-reconciler.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_heal";
const DOMAIN = "heal.test";
const WORKFLOW = "pr-triage";
const REPO = "acme/widgets";
const NOW = new Date("2026-10-12T12:00:00Z");
const MINUTE = 60_000;
const CONFIG = { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true, installationId: 1 }] } };
const PACK = { name: checkPackName(REPO), schemaVersion: 1, repo: REPO, checks: [] } as unknown as CheckPack;
const BUNDLE = {
  source: { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-workflow" } },
  entry: "./pr-triage.mjs",
  projection: { id: WORKFLOW, stepOrder: ["a"], steps: { a: { kind: "step", id: "a" } }, triggers: [] },
  closure: { schemaVersion: "1", topLevel: [], entries: [] },
  approvedWireHash: "deadbeef",
  approvedGrants: [],
};

type Anchor = { status: "deployed" | "failed" | "cancelled"; createdAt: Date; endedAt?: Date; cancellationRequestedAt?: Date };

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function withHub(body: (hub: ReturnType<typeof harness>) => Promise<void>): Promise<void> {
  const database = `corbits_heal_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Heal", slug: "heal", domain: DOMAIN, config: CONFIG });
    await handle.db.insert(schema.principal).values({ id: "prn_deployer", tenantId: TENANT, kind: "user", refId: "deployer", status: "active" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: WORKFLOW });
    await body(harness(handle.db));
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function harness(db: ReturnType<typeof createDB>["db"]) {
  const launchSpecs = createWorkflowRunLaunchSpecStore(db);
  const prepared: PrepareProvisionedWorkflowDeploymentArgs[] = [];
  const delivered: { address: string; payload: unknown }[] = [];
  const logged: Record<string, unknown>[] = [];
  const rows = new Map<string, PrTriageRow[]>();

  async function anchor(runId: string, at: Anchor): Promise<void> {
    await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_triage", tenantId: TENANT, ...at });
    await launchSpecs.create({
      anchorRunId: runId,
      sessionId: `ses_${runId}`,
      deploymentDomain: DOMAIN,
      sourceAuthorityPrincipalId: "prn_deployer",
      frozenApprovalBundle: BUNDLE,
      sourceOfferingIds: ["off_a", "off_b"],
      defaultSourceOfferingId: "off_a",
      deployContent: { systemPrompt: "Triage pull requests." },
    });
  }

  // Stands in for Interchange's provisioning: the new deployment is an anchor run born `deployed` with its own launch spec.
  const allocation = {
    async prepareProvisionedDeployment(args: PrepareProvisionedWorkflowDeploymentArgs) {
      prepared.push(args);
      await anchor(args.anchorRunId, { status: "deployed", createdAt: NOW });
      return { anchorRunId: args.anchorRunId, deploymentAddress: `${args.anchorRunId}@${DOMAIN}`, allocationId: "alc", status: "pending" as const };
    },
  } as unknown as WorkflowAllocationService;

  function live() {
    return resolveLiveDeployments(db, TENANT, WORKFLOW);
  }

  // Runs once the reconciler has read the failed deployment and before it looks for a live one, like a portal deploy landing mid-pass.
  const hooks: { beforeRedeploy?: () => Promise<void> } = {};
  async function liveDeployments() {
    await hooks.beforeRedeploy?.();
    hooks.beforeRedeploy = undefined;
    return live();
  }

  const reconcile = createTriageReconciler({
    tenants: async () => [{ id: TENANT, domain: DOMAIN, config: CONFIG }],
    liveDeployments,
    latestDeployments: (tenantId, limit) => latestDeployments(db, tenantId, WORKFLOW, limit),
    rotation: {
      afterRuns: 1_000,
      ...createDeploymentRotation({ db, launchSpecs, allocation, lifecycle: {} as WorkflowLifecycleService, mayDeploy: async () => true }),
    },
    openHeadsFor: async () => async () => [{ number: 8, headSha: "abc123", updatedAt: ago(60 * MINUTE).toISOString(), draft: false }],
    observeTenant: async function observeTenant() {
      const deployments = await live();
      return { deployments, observed: deployments.map(() => ({ byRepo: new Map(), runCount: 0, verdicts: [], executed: [] })) };
    },
    store: {
      async load(_tenantId, repo) {
        return { rows: rows.get(repo) ?? [], version: null };
      },
      async save(_tenantId, repo, next) {
        rows.set(repo, next);
        return null;
      },
    },
    readCheckPack: async () => ({ status: "ok", pack: PACK }),
    deliver: async function deliver(_tenantId, address, payload) {
      delivered.push({ address, payload });
    },
    policy: DEFAULT_RECONCILE_POLICY,
    batchSize: DEFAULT_RECONCILE_POLICY.maxInFlight,
    now: () => NOW,
    log: (entry) => logged.push(entry),
  });

  async function update(runId: string, at: Partial<Anchor>): Promise<void> {
    await db.update(schema.workflowRun).set(at).where(eq(schema.workflowRun.id, runId));
  }

  return { anchor, update, reconcile, live, prepared, delivered, logged, hooks };
}

function messages(logged: readonly Record<string, unknown>[]): unknown[] {
  return logged.map((entry) => entry["msg"]).filter((msg) => String(msg).startsWith("triage_heal") || msg === "triage_deployment_healed");
}

test("PostgreSQL: a deployment Interchange failed is deployed again from its launch spec, and the next pass mails the copy", async () => {
  await withHub(async (hub) => {
    await hub.anchor("run_failed", { status: "failed", createdAt: ago(60 * MINUTE), endedAt: ago(3 * MINUTE) });
    expect(await hub.reconcile()).toEqual({ retry: true });
    expect(hub.prepared).toHaveLength(1);
    const copy = hub.prepared[0]!.anchorRunId;
    expect(copy).not.toBe("run_failed");
    expect((await hub.live()).map((live) => live.runId)).toEqual([copy]);
    expect(hub.logged).toContainEqual(expect.objectContaining({ msg: "triage_deployment_healed", deployment: "run_failed", replacedBy: copy }));

    expect(await hub.reconcile()).toEqual({ retry: false });
    expect(hub.delivered.map((mail) => mail.address)).toEqual([`${copy}@${DOMAIN}`]);
    expect(hub.prepared).toHaveLength(1);
  });
}, 120_000);

test("PostgreSQL: a deployment the portal made during the pass is kept, and no copy is made", async () => {
  await withHub(async (hub) => {
    await hub.anchor("run_failed", { status: "failed", createdAt: ago(60 * MINUTE), endedAt: ago(3 * MINUTE) });
    hub.hooks.beforeRedeploy = () => hub.anchor("run_portal", { status: "deployed", createdAt: NOW });
    expect(await hub.reconcile()).toEqual({ retry: true });
    expect(hub.prepared).toEqual([]);
    expect((await hub.live()).map((live) => live.runId)).toEqual(["run_portal"]);
    expect(messages(hub.logged)).toEqual([]);
  });
}, 120_000);

test("PostgreSQL: a failure under two minutes old is waited on; a cancelled or released deployment is never redeployed", async () => {
  await withHub(async (hub) => {
    await hub.anchor("run_a", { status: "failed", createdAt: ago(60 * MINUTE), endedAt: ago(30_000) });
    expect(await hub.reconcile()).toEqual({ retry: true });
    await hub.update("run_a", { status: "cancelled", endedAt: ago(10 * MINUTE) });
    expect(await hub.reconcile()).toEqual({ retry: false });
    await hub.update("run_a", { status: "failed", cancellationRequestedAt: ago(11 * MINUTE) });
    expect(await hub.reconcile()).toEqual({ retry: false });
    expect(hub.prepared).toEqual([]);
    expect(messages(hub.logged)).toEqual([]);
  });
}, 120_000);

test("PostgreSQL: three failed deployments of one source within an hour stop the redeploys until the oldest failure is an hour old", async () => {
  await withHub(async (hub) => {
    await hub.anchor("run_1", { status: "failed", createdAt: ago(50 * MINUTE), endedAt: ago(40 * MINUTE) });
    await hub.anchor("run_2", { status: "failed", createdAt: ago(30 * MINUTE), endedAt: ago(20 * MINUTE) });
    await hub.anchor("run_3", { status: "failed", createdAt: ago(10 * MINUTE), endedAt: ago(5 * MINUTE) });
    expect(await hub.reconcile()).toEqual({ retry: false });
    expect(hub.prepared).toEqual([]);
    expect(messages(hub.logged)).toEqual(["triage_heal_capped"]);

    await hub.update("run_1", { endedAt: ago(61 * MINUTE) });
    expect(await hub.reconcile()).toEqual({ retry: true });
    expect(hub.prepared).toHaveLength(1);
    expect(messages(hub.logged)).toEqual(["triage_heal_capped", "triage_deployment_healed"]);
  });
}, 120_000);
