// Every webhook and reviewer result of a pull request on the manager path comes in here. The event is recorded first,
// then the one intake that wins the claim deploys a manager and mails it; the others nudge the live manager without
// waiting for it, and restart it when it is gone.
import { and, eq } from "drizzle-orm";
import { schema, type DB, type WorkflowRunLaunchSpecStore } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { WorkflowAllocationService } from "@intx/hub-sessions";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE, repoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { allowCreator } from "./github/admin-github-grant.js";
import { mailPayload, triagePolicy, unreadablePayload } from "./github/bridge.js";
import type { PolicyReader } from "./github/check-pack-store.js";
import { resolveLiveDeployment, retryUntilReady, type ReadyWait } from "./github/deployment.js";
import { triageWorkflowFor } from "./github/source-workflow.js";
import { repoRecords, sourceOf, triageNs } from "./github/tenant-config.js";
import { ManagerUnavailableError } from "./manager-unavailable.js";
import { claimForIntake, markLive, recordEvent, restartClaim, type IntakeEvent, type PullRequestRef } from "./manager-state.js";

/** A host's published manager: its workflow asset's name, and the package entry and pin it is deployed from. */
export type ManagerDefinition = { assetName: string; entry: string; pin: string };

export type ManagerIntakeDeps = {
  db: DB["db"];
  allocation: Pick<WorkflowAllocationService, "prepareProvisionedDeployment">;
  launchSpecs: Pick<WorkflowRunLaunchSpecStore, "get">;
  managers: Partial<Record<RepoSource, ManagerDefinition>>;
  readCheckPack: PolicyReader;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  /** How long a new manager may take to accept its first mail. */
  firstMail: ReadyWait;
  now: () => Date;
};

export type ManagerIntake = (tenantId: string, pr: PullRequestRef, deliveryId: string, event: IntakeEvent) => Promise<{ recorded: boolean }>;

type Launch = { manager: ManagerDefinition; assetId: string; creatorId: string; spec: NonNullable<Awaited<ReturnType<WorkflowRunLaunchSpecStore["get"]>>> };

export function createManagerIntake(deps: ManagerIntakeDeps): ManagerIntake {
  /** The host's manager asset and pin, deployed as whoever deployed the host's pr-triage listener, with its offerings and registry. */
  async function launchFor(tenantId: string, source: RepoSource): Promise<Launch> {
    const manager = deps.managers[source];
    if (!manager) throw new ManagerUnavailableError(`No manager is published for ${source}.`);
    const asset = await deps.db.query.asset.findFirst({
      where: and(eq(schema.asset.tenantId, tenantId), eq(schema.asset.kind, "workflow"), eq(schema.asset.name, manager.assetName)),
      columns: { id: true, creatorPrincipalId: true },
    });
    if (!asset?.creatorPrincipalId) throw new ManagerUnavailableError(`${manager.assetName} is not published in this workspace.`);
    const triage = triageWorkflowFor(source).id;
    const listener = await resolveLiveDeployment(deps.db, tenantId, triage);
    if (!listener) throw new ManagerUnavailableError(`No live ${triage} deployment.`);
    const spec = await deps.launchSpecs.get(listener.runId);
    if (!spec) throw new Error(`deployment ${listener.runId} has no launch spec`);
    return { manager, assetId: asset.id, creatorId: asset.creatorPrincipalId, spec };
  }

  /** The pr-triage trigger mail for the pull request at `head`. */
  async function mail(tenantId: string, pr: PullRequestRef, head: string): Promise<unknown> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { config: true } });
    const record = repoRecords(triageNs(tenant?.config)).find((row) => row.name === pr.repo && sourceOf(row) === pr.source);
    if (!record) throw new Error(`${pr.repo} is not connected from ${pr.source}`);
    const stored = await triagePolicy(deps.readCheckPack, tenantId, pr.repo, pr.source);
    if (!stored) throw new Error(`${pr.repo} has no policy`);
    const policy = repoPolicy(record);
    const extra = { tenantId, prNumber: pr.number, headSha: head };
    return "pack" in stored ? mailPayload(record, policy, stored, extra) : unreadablePayload(record, policy, stored, extra);
  }

  async function start(tenantId: string, pr: PullRequestRef, claimId: string, head: string, launch: Launch): Promise<void> {
    const { manager, spec } = launch;
    if (spec.frozenApprovalBundle.source.kind !== "asset") throw new Error("the pr-triage listener is not deployed from the package registry");
    await deps.db.transaction(function grantCreator(tx) {
      return allowCreator(tx, tenantId, launch.creatorId, MANAGER_STATE_RESOURCE, MANAGER_STATE_ACTION, deps.now());
    });
    const { anchorRunId, deploymentAddress } = await deps.allocation.prepareProvisionedDeployment({
      tenantId,
      anchorRunId: generateId("workflowRun"),
      deploymentDomain: spec.deploymentDomain,
      source: spec.frozenApprovalBundle.source,
      entry: manager.entry,
      pin: manager.pin,
      definitionAssetId: launch.assetId,
      sessionId: generateId("session"),
      sourceAuthorityPrincipalId: spec.sourceAuthorityPrincipalId,
      sourceOfferingIds: spec.sourceOfferingIds,
      defaultSourceOfferingId: spec.defaultSourceOfferingId,
      deployContent: { systemPrompt: "" },
    });
    // A claim taken over meanwhile has its own manager; the reconciler releases this one.
    if (!(await markLive(deps.db, tenantId, pr, claimId, anchorRunId))) return;
    const payload = await mail(tenantId, pr, head);
    await retryUntilReady(function firstMail() {
      return deps.deliver(tenantId, deploymentAddress, payload);
    }, deps.firstMail);
  }

  async function gone(err: unknown, runId: string): Promise<boolean> {
    if (isRunTriggerUnroutable(err)) return true;
    const run = await deps.db.query.workflowRun.findFirst({ where: eq(schema.workflowRun.id, runId), columns: { status: true } });
    return !run || !schema.isLiveWorkflowRunStatus(run.status);
  }

  async function nudge(tenantId: string, pr: PullRequestRef, runId: string, head: string, launch: Launch): Promise<void> {
    try {
      await deps.deliver(tenantId, `${runId}@${launch.spec.deploymentDomain}`, await mail(tenantId, pr, head));
    } catch (err) {
      if (!(await gone(err, runId))) throw err;
      const claimId = await restartClaim(deps.db, tenantId, pr, runId);
      if (claimId) await start(tenantId, pr, claimId, head, launch);
    }
  }

  return async function managerIntake(tenantId, pr, deliveryId, event) {
    const recorded = await recordEvent(deps.db, tenantId, pr, deliveryId, event);
    // Checked before the claim, so a workspace that cannot start a manager never leaves one starting.
    const launch = await launchFor(tenantId, pr.source);
    const claim = await claimForIntake(deps.db, tenantId, pr);
    if (claim.outcome === "won") await start(tenantId, pr, claim.claimId, event.head, launch);
    if (claim.outcome === "live") await nudge(tenantId, pr, claim.runId, event.head, launch);
    return { recorded };
  };
}
