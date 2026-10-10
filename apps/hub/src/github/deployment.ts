import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type DB, type WorkflowRunLaunchSpecStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { WorkflowAllocationService, WorkflowLifecycleService } from "@intx/hub-sessions";
import type { RunTriggerMaterialize } from "@corbits/webhooks";
import type { ToolPackageManifest } from "@intx/types/tool-packages";
import type { FrozenApprovalBundle } from "@intx/types/sidecar";
import { claimRotation, clearRotation, type RotationRecord } from "./tenant-config.js";

export class NoLiveDeploymentError extends Error {
  constructor(readonly workflow: string) {
    super(`no live ${workflow} deployment`);
  }
}

/** The materializer's `notReady` outcome: the deployment has not recorded its credential resolution yet. */
export class DeploymentNotReadyError extends Error {
  readonly code = "deployment_not_ready";
  constructor() {
    super("The workflow deployment is still starting.");
  }
}

/** @corbits/webhooks 0.3.0 ignores `notReady` and routes the mail without grants; this fails it so the caller retries. Drop once the package handles it. */
export function readyMaterializer(materialize: RunTriggerMaterialize): RunTriggerMaterialize {
  return async function materializeReady(args) {
    const grants = await materialize(args);
    if (grants.outcome === "notReady") throw new DeploymentNotReadyError();
    return grants;
  };
}

/** `cancelling` once cancellation was requested: the run stays live until the lifecycle sweep stops it. */
export type LiveDeployment = { runId: string; address: string; createdAt: Date; cancelling: boolean };

export type TenantDeployment = LiveDeployment & { workflow: string };

/** Matches how the hub lists deployments: a deployment is its anchor run. Newest first; every workflow's when no name is given. */
export async function resolveLiveDeployments(
  db: DB["db"],
  tenantId: string,
  definitionName?: string,
): Promise<TenantDeployment[]> {
  const { workflowRun, workflowDefinition, tenant, liveWorkflowRunStatuses } = schema;
  const rows = await db
    .select({
      runId: workflowRun.id,
      workflow: workflowDefinition.name,
      domain: tenant.domain,
      createdAt: workflowRun.createdAt,
      cancellationRequestedAt: workflowRun.cancellationRequestedAt,
    })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .where(and(
      eq(workflowRun.tenantId, tenantId),
      definitionName === undefined ? undefined : eq(workflowDefinition.name, definitionName),
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
    workflow: row.workflow,
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

export type PackageVersion = { name: string; version: string };

function rootOf(closure: ToolPackageManifest): PackageVersion {
  const [root, ...rest] = closure.topLevel;
  if (!root || rest.length > 0) throw new Error(`frozen closure has ${String(closure.topLevel.length)} top-level packages, expected one`);
  return { name: root.name, version: root.version };
}

/** The launch spec does not store the pin, so it is read back from the frozen closure. */
export function pinOf(closure: ToolPackageManifest): string {
  const { name, version } = rootOf(closure);
  return `${name}@${version}`;
}

export type ClosureVersions = { workflow: PackageVersion; tools: PackageVersion[] };

/** The pinned workflow package and the packages its closure carries; null for a deployment not pinned from a tarball. */
export function closureVersions(bundle: FrozenApprovalBundle): ClosureVersions | null {
  if (pinFor(bundle) === undefined) return null;
  const workflow = rootOf(bundle.closure);
  const tools = bundle.closure.entries
    .filter((entry) => entry.name !== workflow.name)
    .map((entry) => ({ name: entry.name, version: entry.version }));
  return { workflow, tools };
}

/** A tarball-format source names its package only through the pin. */
function pinFor(bundle: FrozenApprovalBundle): string | undefined {
  if (bundle.source.kind !== "asset" || bundle.source.package.format !== "tarball") return undefined;
  return pinOf(bundle.closure);
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
  /** A tarball source is the shared package registry, so the workflow asset is read from the run's definition. */
  async function definitionAssetId(tenantId: string, anchorRunId: string): Promise<string> {
    const { workflowRun, workflowDefinition } = schema;
    const [row] = await deps.db
      .select({ assetId: workflowDefinition.assetId })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .where(and(eq(workflowRun.id, anchorRunId), eq(workflowRun.tenantId, tenantId)));
    if (!row?.assetId) throw new Error(`deployment ${anchorRunId} has no workflow definition asset`);
    return row.assetId;
  }

  async function redeploy(tenantId: string, anchorRunId: string): Promise<Redeployed> {
    const spec = await deps.launchSpecs.get(anchorRunId);
    if (!spec) throw new Error(`deployment ${anchorRunId} has no launch spec`);
    const { source, entry } = spec.frozenApprovalBundle;
    if (source.kind !== "asset") throw new Error(`deployment ${anchorRunId} is not deployed from a workflow asset`);
    const pin = pinFor(spec.frozenApprovalBundle);
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
    const definition = pin === undefined ? source.assetId : await definitionAssetId(tenantId, anchorRunId);
    const prepared = await deps.allocation.prepareProvisionedDeployment({
      tenantId,
      anchorRunId: generateId("workflowRun"),
      deploymentDomain: spec.deploymentDomain,
      source,
      entry,
      ...(pin !== undefined ? { pin } : {}),
      definitionAssetId: definition,
      sessionId: generateId("session"),
      sourceAuthorityPrincipalId: spec.sourceAuthorityPrincipalId,
      sourceOfferingIds: spec.sourceOfferingIds,
      defaultSourceOfferingId: spec.defaultSourceOfferingId,
      deployContent: { ...spec.deployContent, systemPrompt },
    });
    return { status: "deployed", runId: prepared.anchorRunId };
  }

  /** Whether both deployments run the same workflow asset, package, pin and entry. */
  async function sameSource(anchorRunId: string, otherAnchorRunId: string): Promise<boolean> {
    const [spec, other] = await Promise.all([deps.launchSpecs.get(anchorRunId), deps.launchSpecs.get(otherAnchorRunId)]);
    if (!spec || !other) return false;
    const a = spec.frozenApprovalBundle;
    const b = other.frozenApprovalBundle;
    if (a.source.kind !== "asset" || b.source.kind !== "asset" || a.entry !== b.entry) return false;
    return a.source.assetId === b.source.assetId
      && JSON.stringify(a.source.package) === JSON.stringify(b.source.package)
      && pinFor(a) === pinFor(b);
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
