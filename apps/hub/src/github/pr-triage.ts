// Queues one open pull request's head for the live pr-triage deployment at a
// maintainer's request. The row is marked queued before the mail goes out so
// repeated clicks and reconcile passes see it; a failed mail puts it back.
// Attempts are left alone: a head the hub gave up on is only ever retried here.
import { eq } from "drizzle-orm";
import { type } from "arktype";
import { schema } from "@intx/db";
import { hasEnabledRules, repoPolicy, type PrTriageRow, type RepoSource } from "@corbits/triage-contracts";
import { errorText } from "@corbits/common";
import { mailPayload } from "./bridge.js";
import type { TriageJob } from "./coordinator.js";
import type { PolicyReader } from "./check-pack-store.js";
import { githubLimited } from "./github-refusal.js";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import type { ManagerRuns } from "./manager-runs.js";
import { isStuck, runKey, type ObservedRun, type ReconcilePolicy } from "./reconcile-plan.js";
import { triageWorkflowFor } from "./source-workflow.js";
import { repoRecords, sourceOf, triageNs, triageStateKey, type RepoRecord } from "./tenant-config.js";
import { newestLive, type LiveDeployment } from "./deployment.js";
import { mergeObservedRuns, observeDeployments, type ObservedRuns, type ObserveRuns } from "./triage-runs.js";
import { isQueuedSince, isRunningSince, queueHead, restoreHead } from "./triage-queue.js";
import type { TriageStateStore } from "./triage-state-store.js";

export const GITHUB_PR_TRIAGE_PATH = "/api/integrations/github-triage";

export const TriageBody = type({ repo: /^[\w.-]+\/[\w.-]+$/, number: "number.integer > 0" });

export type GithubPrTriageDeps = PortalCredentialDeps & {
  /** The open pull request's head on the record's host, or undefined when it is not open. */
  pullHead: (tenantId: string, record: RepoRecord, number: number) => Promise<string | undefined>;
  readCheckPack: PolicyReader;
  /** The named workflow's, newest first; mail goes to the first, and a head may still be running on a replaced one. */
  liveDeployments: (tenantId: string, workflow: string) => Promise<LiveDeployment[]>;
  observeRuns: ObserveRuns;
  managerRuns: ManagerRuns;
  store: TriageStateStore;
  send: (job: TriageJob) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * The member's connected record of `repo` on `source`, or why they may not triage it. A caller that cannot name the host
 * gets none where both hosts hold the name.
 */
export async function grantedTriageRecord(deps: PortalCredentialDeps, { tenantId, principalId }: Member, repo: string, source: RepoSource | undefined) {
  const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
  if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
  const named = repoRecords(triageNs(tenant.config)).filter((row) => row.name === repo && row.connected && (source === undefined || sourceOf(row) === source));
  const record = named.length === 1 ? named[0] : undefined;
  if (!record) return failure(409, "repo_not_connected", `${repo} is not connected to this workspace, or is connected from both hosts.`);
  return (await sourceCredentialGrant(deps, principalId, tenantId, record, "use")) ?? { tenant, record };
}

/** The policy and rules `record` is triaged with, or why it is not triaged. */
export async function triageInputs(deps: { readCheckPack: PolicyReader }, tenantId: string, record: RepoRecord) {
  const policy = repoPolicy(record);
  if (!policy.enabled) return failure(409, "repo_not_enabled", "Triage is disabled for this repository. Enable it first.");
  const pack = await deps.readCheckPack(tenantId, record.name, sourceOf(record));
  if (pack.status === "corrupt") return failure(409, "check_pack_unreadable", "This repository's policy is unreadable. Replace it on the repository page.", { reason: pack.reason });
  if (pack.status === "invalid") return failure(409, "policy_file_invalid", `Triage does not run until ${pack.path} is fixed.`, { reason: pack.reason });
  if (pack.status !== "ok") return failure(409, "needs_setup", "This repository still needs a policy.");
  if (!hasEnabledRules(pack.pack)) return failure(409, "no_rules", "Switch on a rule first; with every rule off there is nothing to triage.");
  return { policy, pack };
}

async function readyToTriage(deps: GithubPrTriageDeps, member: Member, repo: string) {
  const granted = await grantedTriageRecord(deps, member, repo, "github");
  if (granted instanceof Response) return granted;
  const inputs = await triageInputs(deps, member.tenantId, granted.record);
  if (inputs instanceof Response) return inputs;
  return { ...granted, ...inputs };
}

/** The runs that named the head; none when no run did. */
function headRuns(runs: ObservedRuns, repo: string, key: string): readonly ObservedRun[] {
  const listed = runs.byRepo.get(repo)?.get(key);
  return listed === undefined ? [] : listed;
}

/** A manager's done on the head since it was queued settles it, before the reconciler's next pass marks it so. */
function doneSince(row: PrTriageRow | undefined, runs: readonly ObservedRun[], policy: ReconcilePolicy): boolean {
  if (row?.queuedAt === undefined) return false;
  const since = new Date(row.queuedAt).getTime() - policy.clockSkewMs;
  return runs.some((run) => run.status === "completed" && new Date(run.startedAt).getTime() >= since);
}

export function createGithubPrTriage(deps: GithubPrTriageDeps) {
  return async function handle({ repo, number }: typeof TriageBody.infer, member: Member): Promise<Response> {
    const { tenantId, principalId } = member;
    const ready = await readyToTriage(deps, member, repo);
    if (ready instanceof Response) return ready;
    const { tenant, record, policy, pack } = ready;
    const triage = triageWorkflowFor(sourceOf(record));
    const deployments = await deps.liveDeployments(tenantId, triage.id);
    const deployment = newestLive(deployments);
    if (!deployment) return failure(503, "service_not_running", `The ${triage.id} service is not running.`);

    let openHead: string | undefined;
    try {
      openHead = await deps.pullHead(tenantId, record, number);
    } catch (err) {
      const message = errorText(err);
      return githubLimited(err) ?? failure(502, "source_failed", `Could not read ${repo}#${number}: ${message}.`);
    }
    if (openHead === undefined) return failure(409, "pull_request_not_open", `${repo}#${number} is not an open pull request.`);
    const headSha = openHead;

    const now = deps.now();
    const key = runKey(number, headSha);
    const managed = headRuns(await deps.managerRuns(tenantId, sourceOf(record), undefined), repo, key);
    const runs = [...headRuns(mergeObservedRuns(await observeDeployments(deps.observeRuns, deployments, tenant.domain)), repo, key), ...managed];
    if (runs.some((run) => run.status === "running" && !isStuck(run, now, deps.policy))) {
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    const head = { tenantId, repo: triageStateKey(record), number, headSha };
    const queued = await queueHead(deps.store, head, now, function busy(prior) {
      return (isQueuedSince(prior, now, deps.policy) || isRunningSince(prior, now, deps.policy)) && !doneSince(prior, managed, deps.policy);
    }, false);
    if (queued.status === "kept") {
      if (isQueuedSince(queued.prior, now, deps.policy)) return failure(409, "already_queued", `${repo}#${number} is already queued for triage.`);
      return failure(409, "already_running", `${repo}#${number} is already being triaged.`);
    }
    if (queued.status === "conflict") return failure(409, "conflict", `${repo}#${number} was just updated by the hub. Try again.`);
    try {
      await deps.send({ ...head, workflow: triage.id, source: "retry", record, payload: mailPayload(record, policy, pack, { prNumber: number, headSha, noWait: true }) });
    } catch (err) {
      deps.log({ level: "error", msg: "triage_request_failed", tenantId, repo, pr: number, headSha, error: String(err) });
      try {
        await restoreHead(deps.store, head, queued.remembered);
      } catch (restoreErr) {
        deps.log({ level: "error", msg: "triage_state_restore_failed", tenantId, repo, pr: number, headSha, error: String(restoreErr) });
      }
      return githubLimited(err) ?? failure(502, "hub_unavailable", `Could not queue ${repo}#${number}: ${errorText(err)}. Try again.`);
    }
    deps.log({ level: "info", msg: "triage_requested", tenantId, principalId, repo, pr: number, headSha });
    return Response.json({ status: "queued", headSha }, { status: 202 });
  };
}
