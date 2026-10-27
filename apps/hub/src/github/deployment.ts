import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type DB, type ResolvedSenderPrincipal } from "@intx/db";
import { MAIL_ADMISSION_DENIED_CODE } from "@intx/hub-sessions";
import type { RunTriggerMaterialize } from "@corbits/webhooks";
import type { ToolPackageManifest } from "@intx/types/tool-packages";
import type { FrozenApprovalBundle } from "@intx/types/sidecar";
import { TRIAGE_LISTENERS, triageStopped, type RepoSource } from "@corbits/triage-contracts";

export class NoLiveDeploymentError extends Error {
  constructor(readonly workflow: string) {
    super(`no live ${workflow} deployment`);
  }
}

/** A workspace runs no listener for the host, so its pull requests wait for the hub to start one; the message says where to look. */
export class TriageStoppedError extends NoLiveDeploymentError {
  constructor(source: RepoSource) {
    super(TRIAGE_LISTENERS[source]);
    this.message = triageStopped(source);
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
    const grants = await materialize({ agentAddress, runId, senderCoordinates: sender.coordinates });
    if (grants.outcome === "rejected" && grants.code === MAIL_ADMISSION_DENIED_CODE) throw new SenderRefusedError(grants.message);
    return grants;
  };
}

/** `cancelling` once cancellation was requested: the run stays live until the lifecycle sweep stops it. */
export type LiveDeployment = { runId: string; address: string; createdAt: Date; cancelling: boolean };

export type TenantDeployment = LiveDeployment & { workflow: string };

type DeploymentQuery = { tenantId: string; definitionName?: string };

/**
 * A workflow the hub publishes per workspace deploys from an asset named for its publisher and release, which names
 * its definition too; its frozen projection keeps the workflow's own id, so that is the name a deployment is found by.
 */
export const workflowName = sql<string>`coalesce(${schema.workflowRunLaunchSpec.frozenApprovalBundle} -> 'projection' ->> 'id', ${schema.workflowDefinition.name})`;

/** Matches how the hub lists deployments: a deployment is its anchor run. Newest first, live only. */
async function deploymentsWhere(db: DB["db"], query: DeploymentQuery): Promise<TenantDeployment[]> {
  const { workflowRun, workflowDefinition, workflowRunLaunchSpec, tenant, liveWorkflowRunStatuses } = schema;
  const rows = await db
    .select({
      runId: workflowRun.id,
      workflow: workflowName,
      domain: tenant.domain,
      createdAt: workflowRun.createdAt,
      cancellationRequestedAt: workflowRun.cancellationRequestedAt,
    })
    .from(workflowRun)
    .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
    .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
    .leftJoin(workflowRunLaunchSpec, eq(workflowRunLaunchSpec.anchorRunId, workflowRun.id))
    .where(and(
      eq(workflowRun.tenantId, query.tenantId),
      query.definitionName === undefined ? undefined : eq(workflowName, query.definitionName),
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

/** Live deployments; every workflow's when no name is given. */
export function resolveLiveDeployments(db: DB["db"], tenantId: string, definitionName?: string): Promise<TenantDeployment[]> {
  return deploymentsWhere(db, { tenantId, definitionName });
}

type PackageVersion = { name: string; version: string };

function rootOf(closure: ToolPackageManifest): PackageVersion {
  const [root, ...rest] = closure.topLevel;
  if (!root || rest.length > 0) throw new Error(`frozen closure has ${String(closure.topLevel.length)} top-level packages, expected one`);
  return { name: root.name, version: root.version };
}

export type ClosureVersions = { workflow: PackageVersion; tools: PackageVersion[] };

/** A tarball-format source pins its one top-level package; a source-format one names its package, at the version it built. */
function workflowOf(bundle: FrozenApprovalBundle): PackageVersion | undefined {
  if (bundle.source.kind !== "asset") return undefined;
  if (bundle.source.package.format === "tarball") return rootOf(bundle.closure);
  const { packageName } = bundle.source.package;
  const found = bundle.closure.topLevel.find((pkg) => pkg.name === packageName);
  return found && { name: found.name, version: found.version };
}

export function closureVersions(bundle: FrozenApprovalBundle): ClosureVersions | null {
  const workflow = workflowOf(bundle);
  if (!workflow) return null;
  const tools = bundle.closure.entries
    .filter((entry) => entry.name !== workflow.name)
    .map((entry) => ({ name: entry.name, version: entry.version }));
  return { workflow, tools };
}
