import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { schema, type DB, type ResolvedSenderPrincipal, type WorkflowRunLaunchSpecStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { MAIL_ADMISSION_DENIED_CODE, type WorkflowAllocationService, type WorkflowLifecycleService } from "@intx/hub-sessions";
import type { RunTriggerMaterialize } from "@corbits/webhooks";
import type { ToolPackageManifest } from "@intx/types/tool-packages";
import type { FrozenApprovalBundle } from "@intx/types/sidecar";
import { claimRotation, clearRotation, type RotationRecord } from "./tenant-config.js";

export class NoLiveDeploymentError extends Error {
  constructor(readonly workflow: string) {
    super(`no live ${workflow} deployment`);
  }
}

export class DeploymentNotReadyError extends Error {
  readonly code = "deployment_not_ready";
  constructor() {
    super("The workflow deployment is still starting.");
  }
}

/** Interchange's sender gate refused the mail; a worker copied from a listener deployed before the gate keeps refusing until the listener is redeployed. */
export class SenderRefusedError extends Error {
  readonly code = MAIL_ADMISSION_DENIED_CODE;
}

/** @corbits/webhooks 0.3.0 ignores `notReady` and routes the mail without grants; this fails it so the caller retries. Drop once the package handles it. */
export function readyMaterializer(materialize: RunTriggerMaterialize): RunTriggerMaterialize {
  return async function materializeReady(args) {
    const grants = await materialize(args);
    if (grants.outcome === "notReady") throw new DeploymentNotReadyError();
    return grants;
  };
}

/** @corbits/webhooks 0.3.1 materializes without its sender, which Interchange's sender gate refuses; this names the system sender the mail is signed as. Drop once the package passes it. */
export function systemSenderMaterializer(materialize: RunTriggerMaterialize, sender: ResolvedSenderPrincipal) {
  return async function materializeAsSender({ agentAddress, runId }: { agentAddress: string; runId: string }) {
    const grants = await materialize({ agentAddress, runId, senderPrincipalId: sender.principalId, senderCoordinates: sender.coordinates });
    if (grants.outcome === "rejected" && grants.code === MAIL_ADMISSION_DENIED_CODE) throw new SenderRefusedError(grants.message);
    return grants;
  };
}

/**
 * `cancelling` once cancellation was requested: the run stays live until the lifecycle sweep stops it. `workflowVersion`
 * once read from its launch spec, for one pinned from the package registry; `offeringId`, the decision-model offering
 * the deployment resolved, once read from its launch spec.
 */
export type LiveDeployment = { runId: string; address: string; createdAt: Date; cancelling: boolean; endedAt?: Date; workflowVersion?: string; offeringId?: string };

export type TenantDeployment = LiveDeployment & { workflow: string };

/**
 * A worker deployment carries this key in its deploy content, so the hub can tell it from the listener it was copied
 * from: a worker is spawned for one mail and released when that run ends, and nothing else may mail it or count it as a
 * rotation.
 */
export const WORKER_MARKER = "corbitsTriageWorker";

export type DeploymentKind = "listener" | "worker";

function markedAs(kind: DeploymentKind) {
  const marker = sql`${schema.workflowRunLaunchSpec.deployContent} ->> ${WORKER_MARKER}`;
  return kind === "worker" ? eq(marker, "true") : isNull(marker);
}

type DeploymentQuery = { tenantId: string; definitionName?: string; kind: DeploymentKind; endedSince?: Date };

/** Matches how the hub lists deployments: a deployment is its anchor run. Newest first; live, or ended since `endedSince`. */
async function deploymentsWhere(db: DB["db"], query: DeploymentQuery): Promise<TenantDeployment[]> {
  const { workflowRun, workflowDefinition, workflowRunLaunchSpec, tenant, liveWorkflowRunStatuses } = schema;
  const live = inArray(workflowRun.status, [...liveWorkflowRunStatuses]);
  const rows = await db
    .select({
      runId: workflowRun.id,
      workflow: workflowDefinition.name,
      domain: tenant.domain,
      createdAt: workflowRun.createdAt,
      cancellationRequestedAt: workflowRun.cancellationRequestedAt,
      endedAt: workflowRun.endedAt,
    })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .leftJoin(workflowRunLaunchSpec, eq(workflowRunLaunchSpec.anchorRunId, workflowRun.id))
    .where(and(
      eq(workflowRun.tenantId, query.tenantId),
      query.definitionName === undefined ? undefined : eq(workflowDefinition.name, query.definitionName),
      isNotNull(workflowRun.anchorRunId),
      eq(workflowRun.id, workflowRun.anchorRunId),
      query.endedSince === undefined ? live : or(live, gt(workflowRun.endedAt, query.endedSince)),
      markedAs(query.kind),
    ))
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id));
  return rows.map((row) => ({
    runId: row.runId,
    address: `${row.runId}@${row.domain}`,
    createdAt: row.createdAt,
    cancelling: row.cancellationRequestedAt !== null,
    ...(row.endedAt !== null && { endedAt: row.endedAt }),
    workflow: row.workflow,
  }));
}

/** Live deployments; every workflow's when no name is given; listeners unless workers are asked for. */
export function resolveLiveDeployments(db: DB["db"], tenantId: string, definitionName?: string, kind: DeploymentKind = "listener"): Promise<TenantDeployment[]> {
  return deploymentsWhere(db, { tenantId, definitionName, kind });
}

/** Workers live or released since `endedSince`: a worker's one body run lands in its log before the coordinator cancels the anchor, so the log outlives the deployment. */
export function recentWorkers(db: DB["db"], tenantId: string, definitionName: string, endedSince: Date): Promise<TenantDeployment[]> {
  return deploymentsWhere(db, { tenantId, definitionName, kind: "worker", endedSince });
}

/** Every tenant's live worker deployments, for the release of workers a hub restart orphaned. */
export async function liveWorkers(db: DB["db"]): Promise<{ tenantId: string; runId: string }[]> {
  const { workflowRun, workflowRunLaunchSpec, liveWorkflowRunStatuses } = schema;
  return db
    .select({ tenantId: workflowRun.tenantId, runId: workflowRun.id })
    .from(workflowRun)
    .innerJoin(workflowRunLaunchSpec, eq(workflowRunLaunchSpec.anchorRunId, workflowRun.id))
    .where(and(eq(workflowRun.id, workflowRun.anchorRunId), inArray(workflowRun.status, [...liveWorkflowRunStatuses]), markedAs("worker")));
}

/** A deployment in any status: `cancelling` tells one released on purpose from one Interchange failed. */
export type DeploymentRecord = { runId: string; status: (typeof schema.workflowRun.$inferSelect)["status"]; endedAt: Date | null; cancelling: boolean };

export async function latestDeployments(db: DB["db"], tenantId: string, definitionName: string, limit: number): Promise<DeploymentRecord[]> {
  const { workflowRun, workflowDefinition } = schema;
  const rows = await db
    .select({ runId: workflowRun.id, status: workflowRun.status, endedAt: workflowRun.endedAt, cancellationRequestedAt: workflowRun.cancellationRequestedAt })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .where(and(eq(workflowRun.tenantId, tenantId), eq(workflowDefinition.name, definitionName), eq(workflowRun.id, workflowRun.anchorRunId)))
    .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
    .limit(limit);
  return rows.map(({ cancellationRequestedAt, ...row }) => ({ ...row, cancelling: cancellationRequestedAt !== null }));
}

export type ActiveTenant = { id: string; domain: string };

/**
 * Tenants with a child run of the definition in flight, or ended or created since `endedSince`: a run inserted already
 * completed, as a Bitbucket run is, keeps a null `endedAt` (stock leaves a terminal run routable that way), so its
 * creation time is what says it just ended, and its verdict is recorded within a pass.
 */
export async function activeTenants(db: DB["db"], definitionName: string, what: "runs" | "deployments", endedSince?: Date): Promise<ActiveTenant[]> {
  const { workflowRun, workflowDefinition, tenant, liveWorkflowRunStatuses } = schema;
  const running = eq(workflowRun.status, "running");
  const childRuns = endedSince === undefined ? running : or(running, gt(workflowRun.endedAt, endedSince), gt(workflowRun.createdAt, endedSince));
  return db
    .selectDistinct({ id: tenant.id, domain: tenant.domain })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .where(and(
      eq(workflowDefinition.name, definitionName),
      what === "runs" ? ne(workflowRun.id, workflowRun.anchorRunId) : eq(workflowRun.id, workflowRun.anchorRunId),
      what === "runs" ? childRuns : inArray(workflowRun.status, [...liveWorkflowRunStatuses]),
    ));
}

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

type PackageVersion = { name: string; version: string };

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

export async function withWorkflowVersions<T extends LiveDeployment>(
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">,
  deployments: readonly T[],
): Promise<T[]> {
  const versioned: T[] = [];
  for (const deployment of deployments) {
    const spec = await launchSpecs.get(deployment.runId);
    const workflowVersion = spec ? closureVersions(spec.frozenApprovalBundle)?.workflow.version : undefined;
    const offeringId = spec?.defaultSourceOfferingId ?? undefined;
    versioned.push({ ...deployment, ...(workflowVersion !== undefined && { workflowVersion }), ...(offeringId !== undefined && { offeringId }) });
  }
  return versioned;
}

export type DeploymentRotationDeps = {
  db: DB["db"];
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">;
  allocation: WorkflowAllocationService;
  lifecycle: WorkflowLifecycleService;
  /** As the stock deploy route requires. */
  mayDeploy: (principalId: string, tenantId: string) => Promise<boolean>;
  /** Where the tenant config records this deployment's rotation; the GitHub one keeps the original key. */
  rotationKey?: string;
};

export const ROTATION_REASON = "Replaced by a fresh deployment of the same workflow";

export type Redeployed = { status: "deployed"; runId: string } | { status: "skipped"; reason: string };

/**
 * A deployment's run log grows with every run and the stock hub validates each
 * received commit against all of it, so a busy deployment is replaced by a
 * fresh one. The copy is what the stock deploy route would create from the same
 * request, read from the deployment's launch spec: its source and commit,
 * entry, offerings, deploy content and the principal that deployed it. The
 * copy keeps that principal because the workflow runs as it; it is used only
 * while the stock route would still accept it: an active member holding the
 * route's grant. `content` is added to the copy's deploy content; a worker is
 * marked that way.
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

  async function redeploy(tenantId: string, anchorRunId: string, content: Record<string, unknown> = {}): Promise<Redeployed> {
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
      deployContent: { ...spec.deployContent, ...content, systemPrompt },
    });
    return { status: "deployed", runId: prepared.anchorRunId };
  }

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
    await deps.lifecycle.requestCancellation(tenantId, anchorRunId, ROTATION_REASON);
  }

  function claim(tenantId: string, record: RotationRecord): Promise<boolean> {
    return claimRotation(deps.db, tenantId, record, deps.rotationKey);
  }

  function clear(tenantId: string, record: RotationRecord): Promise<void> {
    return clearRotation(deps.db, tenantId, record, deps.rotationKey);
  }

  return { redeploy, sameSource, release, claim, clear };
}
