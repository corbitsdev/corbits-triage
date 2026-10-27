// What a roll reads from the hub's database: the workspace's catalog, its live deployments and how a deploy is starting,
// and the lock that keeps one roll per workspace.
import { eq } from "drizzle-orm";
import { listVisibleOfferings, schema, type createDB, type DB, type WorkflowRunLaunchSpecStore } from "@intx/db";
import type { ModelInfo } from "@corbits/triage-contracts";
import { resolveLiveDeployments } from "../github/deployment.js";
import { sourceOf } from "../workflow-versions.js";
import type { Deployment, DeployState, Unlock } from "./rollout.js";

type Client = ReturnType<typeof createDB>["db"]["$client"];

/**
 * A session advisory lock on a connection reserved for it, so a roll holds no transaction while it waits for a
 * listener to start; every other query of the roll uses the pool.
 */
export function createWorkspaceLock(client: Client) {
  return async function lock(tenantId: string): Promise<Unlock | undefined> {
    const key = `${tenantId}:workflow-release`;
    const reserved = await client.reserve();
    let held = false;
    try {
      const [row] = await reserved`select pg_try_advisory_lock(hashtext(${key})) as held`;
      held = row?.["held"] === true;
    } finally {
      if (!held) reserved.release();
    }
    if (!held) return undefined;
    return async function unlock() {
      try {
        await reserved`select pg_advisory_unlock(hashtext(${key}))`;
      } finally {
        reserved.release();
      }
    };
  };
}

/** The models the workspace's catalog resolves and the provider of each offering, as stock's model discovery lists them. */
export async function catalogModels(db: DB["db"], tenantId: string): Promise<ModelInfo[]> {
  const models = new Map<string, ModelInfo>();
  for (const { offering, model, provider } of await listVisibleOfferings(db, tenantId)) {
    const info = models.get(model.canonicalName) ?? { canonicalName: model.canonicalName, offerings: [] };
    info.offerings.push({ offeringId: offering.id, providerName: provider.name });
    models.set(model.canonicalName, info);
  }
  return [...models.values()];
}

export async function liveDeployments(db: DB["db"], launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">, tenantId: string, workflow: string): Promise<Deployment[]> {
  const rows: Deployment[] = [];
  for (const live of await resolveLiveDeployments(db, tenantId, workflow)) {
    const spec = await launchSpecs.get(live.runId);
    rows.push({ runId: live.runId, createdAt: live.createdAt, cancelling: live.cancelling, source: spec ? sourceOf(spec.frozenApprovalBundle) : null });
  }
  return rows;
}

const ENDED_ALLOCATIONS = new Set(["releasing", "released", "failed", "destroy_failed"]);

/** As stock's deployment list reports it: live once its sidecar is allocated, ended once stopped or failed. */
export async function deploymentState(db: DB["db"], runId: string): Promise<DeployState> {
  const [row] = await db
    .select({
      status: schema.workflowRun.status,
      cancelling: schema.workflowRun.cancellationRequestedAt,
      allocation: schema.sidecarAllocation.status,
      nextAttemptAt: schema.sidecarAllocation.nextAttemptAt,
    })
    .from(schema.workflowRun)
    .leftJoin(schema.sidecarAllocation, eq(schema.sidecarAllocation.anchorRunId, schema.workflowRun.id))
    .where(eq(schema.workflowRun.id, runId));
  if (!row || !schema.isLiveWorkflowRunStatus(row.status) || row.cancelling !== null) return "ended";
  if (row.allocation !== null && ENDED_ALLOCATIONS.has(row.allocation)) return "ended";
  if (row.allocation === null || (row.allocation === "allocated" && row.nextAttemptAt === null)) return "live";
  return "starting";
}
