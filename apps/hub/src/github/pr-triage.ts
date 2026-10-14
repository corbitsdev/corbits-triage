// Queues one open pull request's head on the live pr-triage deployment at a
// maintainer's request. The row is marked queued before the mail goes out so
// repeated clicks and reconcile passes see it; a failed mail puts it back.
// Attempts are left alone: a head the hub gave up on is only ever retried here.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { repoPolicy } from "@corbits/triage-contracts";
import { isRunTriggerUnroutable } from "@corbits/webhooks";
import { errorText } from "@corbits/common";
import { mailPayload } from "./bridge.js";
import type { CheckPackRead } from "./check-pack-store.js";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { isStuck, runKey, type ReconcilePolicy } from "./reconcile-plan.js";
import { repoRecords, triageNs, triageStateKey, type RepoRecord } from "./tenant-config.js";
import { DeploymentNotReadyError, newestLive, type LiveDeployment } from "./deployment.js";
import { mergeObservedRuns, observeDeployments, type ObserveRuns } from "./triage-runs.js";
import { isQueuedSince, isRunningSince, queueHead, restoreHead } from "./triage-queue.js";
import type { TriageStateStore } from "./triage-state-store.js";

export const GITHUB_PR_TRIAGE_PATH = "/api/integrations/github-triage";

export const TriageBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });

export type GithubPrTriageDeps = PortalCredentialDeps & {
  /** The open pull request's head on the record's host, or undefined when it is not open. */
  pullHead: (tenantId: string, record: RepoRecord, number: number) => Promise<string | undefined>;
  readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead>;
  /** Newest first; mail goes to the first, and a head may still be running on a replaced one. */
  liveDeployments: (tenantId: string) => Promise<LiveDeployment[]>;
  observeRuns: ObserveRuns;
  store: TriageStateStore;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export async function readyToTriage(
  deps: PortalCredentialDeps & { readCheckPack: (tenantId: string, repo: string) => Promise<CheckPackRead> },
  { tenantId, principalId }: Member,
  repo: string,
) {
  const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
  if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
  const record = repoRecords(triageNs(tenant.config)).find((row) => row.name === repo && row.connected);
  if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace.`);
  const refused = await sourceCredentialGrant(deps, principalId, tenantId, record, "use");
  if (refused) return refused;
  const policy = repoPolicy(record);
  if (!policy.enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");
  const pack = await deps.readCheckPack(tenantId, repo);
  if (pack.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's policy is unreadable. Replace it on the repository page.", { reason: pack.reason });
  if (pack.status !== "ok") return failure(409, "needs_setup", "This repository still needs a policy.");
  return { tenant, record, policy, pack };
}

export function createGithubPrTriage(deps: GithubPrTriageDeps) {
  return async function handle({ repo, number }: typeof TriageBody.infer, member: Member): Promise<Response> {
    const { tenantId, principalId } = member;
    const ready = await readyToTriage(deps, member, repo);
    if (ready instanceof Response) return ready;
    const { tenant, record, policy, pack } = ready;
    const deployments = await deps.liveDeployments(tenantId);
    const deployment = newestLive(deployments);
    if (!deployment) return failure(503, "service_not_running", "The pr-triage service is not running.");

    let openHead: string | undefined;
    try {
      openHead = await deps.pullHead(tenantId, record, number);
    } catch (err) {
      const message = errorText(err);
      return failure(502, "source_failed", `Could not read ${repo}#${number}: ${message}.`);
    }
    if (openHead === undefined) return failure(409, "pull_request_not_open", `${repo}#${number} is not an open pull request.`);
    const headSha = openHead;

    const now = deps.now();
    const runs = mergeObservedRuns(await observeDeployments(deps.observeRuns, deployments, tenant.domain)).byRepo.get(repo)?.get(runKey(number, headSha)) ?? [];
    if (runs.some((run) => run.status === "running" && !isStuck(run, now, deps.policy))) {
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    const head = { tenantId, repo: triageStateKey(record), number, headSha };
    const queued = await queueHead(deps.store, head, now, function busy(prior) {
      return isQueuedSince(prior, now, deps.policy) || isRunningSince(prior, now, deps.policy);
    });
    if (queued.status === "kept") {
      if (isQueuedSince(queued.prior, now, deps.policy)) return failure(409, "already_queued", `${repo}#${number} is already queued for triage.`);
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    if (queued.status === "conflict") return failure(409, "conflict", `${repo}#${number} was just updated by the hub. Try again.`);
    try {
      await deps.deliver(tenantId, deployment.address, mailPayload(record, policy, pack, { prNumber: number, headSha }));
    } catch (err) {
      deps.log({ level: "error", msg: "triage_request_failed", tenantId, repo, pr: number, headSha, error: String(err) });
      try {
        await restoreHead(deps.store, head, queued.remembered);
      } catch (restoreErr) {
        deps.log({ level: "error", msg: "triage_state_restore_failed", tenantId, repo, pr: number, headSha, error: String(restoreErr) });
      }
      if (err instanceof DeploymentNotReadyError) return failure(409, err.code, err.message);
      const reason = errorText(err);
      return failure(isRunTriggerUnroutable(err) ? 503 : 502, isRunTriggerUnroutable(err) ? "service_not_running" : "hub_unavailable", `Could not queue ${repo}#${number}: ${reason}. Try again.`);
    }
    deps.log({ level: "info", msg: "triage_requested", tenantId, principalId, repo, pr: number, headSha });
    return Response.json({ status: "queued", headSha }, { status: 202 });
  };
}
