import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type DB, type WorkflowRunLaunchSpecStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { WorkflowAllocationService, WorkflowLifecycleService } from "@intx/hub-sessions";
import { claimRotation, clearRotation, type RotationRecord } from "./tenant-config.js";

export class NoLiveDeploymentError extends Error {
  constructor(readonly workflow: string) {
    super(`no live ${workflow} deployment`);
  }
}

/** `cancelling` once cancellation was requested: the run stays live until the lifecycle sweep stops it. */
export type LiveDeployment = { runId: string; address: string; createdAt: Date; cancelling: boolean };

/** Matches how the hub lists deployments: a deployment is its anchor run. Newest first. */
export async function resolveLiveDeployments(
  db: DB["db"],
  tenantId: string,
  definitionName: string,
): Promise<LiveDeployment[]> {
  const { workflowRun, workflowDefinition, tenant, liveWorkflowRunStatuses } = schema;
  const rows = await db
    .select({ runId: workflowRun.id, domain: tenant.domain, createdAt: workflowRun.createdAt, cancellationRequestedAt: workflowRun.cancellationRequestedAt })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .where(and(
      eq(workflowRun.tenantId, tenantId),
      eq(workflowDefinition.name, definitionName),
      isNotNull(workflowRun.anchorRunId),
      eq(workflowRun.id, workflowRun.anchorRunId),
      inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
    ))
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id));
  return rows.map((row) => ({
    runId: row.runId,
    address: `${row.runId}@${row.domain}`,
    createdAt: row.createdAt,
    cancelling: row.cancellationRequestedAt !== null,
  }));
}

/** The deployment new mail goes to: the newest one not being cancelled. */
export function newestLive(deployments: readonly LiveDeployment[]): LiveDeployment | undefined {
  return deployments.find((live) => !live.cancelling);
}

export async function resolveLiveDeployment(
  db: DB["db"],
  tenantId: string,
  definitionName: string,
): Promise<LiveDeployment | null> {
  return newestLive(await resolveLiveDeployments(db, tenantId, definitionName)) ?? null;
}

export type DeploymentRotationDeps = {
  db: DB["db"];
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">;
  allocation: WorkflowAllocationService;
  lifecycle: WorkflowLifecycleService;
  /** Whether the principal may still deploy workflows, as the stock deploy route requires. */
  mayDeploy: (principalId: string, tenantId: string) => Promise<boolean>;
};

export type Redeployed = { status: "deployed"; runId: string } | { status: "skipped"; reason: string };

/**
 * A deployment's run log grows with every run and the stock hub validates each
 * received commit against all of it, so a busy deployment is replaced by a
 * fresh one. The copy is what the stock deploy route would create from the same
 * request, read from the deployment's launch spec: its source and commit,
 * entry, offerings, deploy content and the principal that deployed it. The
 * copy keeps that principal because the workflow runs as it; it is used only
 * while the stock route would still accept it: an active member holding the
 * route's grant.
 */
export function createDeploymentRotation(deps: DeploymentRotationDeps) {
  async function redeploy(tenantId: string, anchorRunId: string): Promise<Redeployed> {
    const spec = await deps.launchSpecs.get(anchorRunId);
    if (!spec) throw new Error(`deployment ${anchorRunId} has no launch spec`);
    const { source, entry } = spec.frozenApprovalBundle;
    if (source.kind !== "asset") throw new Error(`deployment ${anchorRunId} is not deployed from a workflow asset`);
    const systemPrompt = spec.deployContent["systemPrompt"];
    if (typeof systemPrompt !== "string") throw new Error(`deployment ${anchorRunId} has no system prompt in its deploy content`);
    const deployer = await deps.db.query.principal.findFirst({
      where: and(eq(schema.principal.id, spec.sourceAuthorityPrincipalId), eq(schema.principal.tenantId, tenantId)),
      columns: { status: true },
    });
    if (deployer?.status !== "active") return { status: "skipped", reason: "deployer_inactive" };
    if (!await deps.mayDeploy(spec.sourceAuthorityPrincipalId, tenantId)) {
      return { status: "skipped", reason: "deployer_not_authorized" };
    }
    const prepared = await deps.allocation.prepareProvisionedDeployment({
      tenantId,
      anchorRunId: generateId("workflowRun"),
      deploymentDomain: spec.deploymentDomain,
      source,
      entry,
      definitionAssetId: source.assetId,
      sessionId: generateId("session"),
      sourceAuthorityPrincipalId: spec.sourceAuthorityPrincipalId,
      sourceOfferingIds: spec.sourceOfferingIds,
      defaultSourceOfferingId: spec.defaultSourceOfferingId,
      deployContent: { ...spec.deployContent, systemPrompt },
    });
    return { status: "deployed", runId: prepared.anchorRunId };
  }

  /** Whether both deployments run the same workflow asset, commit and entry. */
  async function sameSource(anchorRunId: string, otherAnchorRunId: string): Promise<boolean> {
    const [spec, other] = await Promise.all([deps.launchSpecs.get(anchorRunId), deps.launchSpecs.get(otherAnchorRunId)]);
    if (!spec || !other) return false;
    const a = spec.frozenApprovalBundle;
    const b = other.frozenApprovalBundle;
    if (a.source.kind !== "asset" || b.source.kind !== "asset" || a.entry !== b.entry) return false;
    return a.source.assetId === b.source.assetId && JSON.stringify(a.source.package) === JSON.stringify(b.source.package);
  }

  async function release(tenantId: string, anchorRunId: string): Promise<void> {
    await deps.lifecycle.requestCancellation(tenantId, anchorRunId, "Replaced by a fresh deployment of the same workflow");
  }

  function claim(tenantId: string, record: RotationRecord): Promise<boolean> {
    return claimRotation(deps.db, tenantId, record);
  }

  function clear(tenantId: string, record: RotationRecord): Promise<void> {
    return clearRotation(deps.db, tenantId, record);
  }

  return { redeploy, sameSource, release, claim, clear };
}
