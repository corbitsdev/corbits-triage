// Brings every open pull request on an enabled repository to a triaged head
// without relying on any webhook, sidecar or portal visit having survived:
// reads GitHub's open pull requests, the live deployments' run logs and the
// stored state, then queues what the plan says, each head to a worker of its own.
// A head waiting for CI is released here once its CI finished or its wait ran
// out, on hosts and pull requests whose CI results send no webhook.
import { dependsOnCi, hasEnabledRules, marksWaiting, repoPolicy, type PrTriageRow, type RepoPolicy, type RepoSource, type VerdictDetail } from "@corbits/triage-contracts";
import { WorkflowProvisioningError } from "@intx/hub-sessions";
import { CAPACITY_UNAVAILABLE } from "../sidecar/host-capacity.js";
import { mailPayload, unreadablePayload, waitingPayload, type PolicyUnreadable } from "./bridge.js";
import type { TriageJob } from "./coordinator.js";
import { GithubRateLimited } from "./github-usage.js";
import { triageWorkflowFor } from "./source-workflow.js";
import { failHead } from "./triage-queue.js";
import type { PolicyReader, StoredPack } from "./check-pack-store.js";
import { inFlight, planTenant, requeue, runKey, type OpenPr, type QueuedPr, type ReconcilePolicy, type RepoPlan } from "./reconcile-plan.js";
import { summarizeChecks, type CiState } from "@corbits/github-reads";
import { repoRecords, rotationRecord, sourceOf, triageNs, triageStateKey, type RepoRecord, type RotationRecord } from "./tenant-config.js";
import type { HeadChecksReader, OpenHeadsReader } from "./tenant-open-heads.js";
import type { RepoActivity } from "./repo-activity.js";
import { newestLive, type DeploymentRecord, type LiveDeployment, type Redeployed } from "./deployment.js";
import type { ManagerRuns } from "./manager-runs.js";
import { isRunning, mergeObservedRuns, type ObservedRuns } from "./triage-runs.js";
import type { TenantObserver } from "./tenant-observer.js";
import type { VerdictRecord, VerdictRecordStore } from "./verdict-record-store.js";
import { TriageStateConflictError, type LoadedTriageState, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export type ReconcileTenant = { id: string; domain: string; config: unknown };

type DeploymentRotation = {
  afterRuns: number;
  redeploy: (tenantId: string, anchorRunId: string) => Promise<Redeployed>;
  sameSource: (anchorRunId: string, otherAnchorRunId: string) => Promise<boolean>;
  /** Requests cancellation; the deployment stays listed, `cancelling`, until the lifecycle sweep stops it. */
  release: (tenantId: string, anchorRunId: string) => Promise<void>;
  claim: (tenantId: string, record: RotationRecord) => Promise<boolean>;
  clear: (tenantId: string, record: RotationRecord) => Promise<void>;
};

export type TriageReconcilerDeps = {
  /** The host whose repositories this reconciler brings to a triaged head; the deployment deps below are its workflow's. */
  source: RepoSource;
  rotationKey: string;
  tenants: () => Promise<ReconcileTenant[]>;
  liveDeployments: (tenantId: string) => Promise<LiveDeployment[]>;
  latestDeployments: (tenantId: string, limit: number) => Promise<DeploymentRecord[]>;
  rotation: DeploymentRotation;
  /** Undefined when the tenant holds no credential for any pull request host. */
  openHeadsFor: (tenantId: string) => Promise<OpenHeadsReader | undefined>;
  /** A repository's open pull requests are listed again only once its last listing may be stale. */
  activity: Pick<RepoActivity, "stale">;
  /**
   * Reads the CI of heads waiting for it, and of settled heads whose verdict waits on CI: those are read again on the
   * unconfirmed retry interval, with backoff, and queued once CI changed, for a host that sends no webhook when a build
   * finishes and for a completed check run whose event was lost or not delivered.
   */
  headChecks: HeadChecksReader;
  /** Recorded verdicts, so a head is polled whichever deployment's run, live or released since, gave its verdict. */
  verdicts: Pick<VerdictRecordStore, "latest">;
  /** Reads and records the live deployments' runs, shared with the recording loop. */
  observeTenant: TenantObserver["observe"];
  /** The host's pull request managers, read from their claims and the verdicts they reported. */
  managerRuns: ManagerRuns;
  store: TriageStateStore;
  readCheckPack: PolicyReader;
  send: (job: TriageJob) => Promise<void>;
  policy: ReconcilePolicy;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

type EnabledRepo = { record: RepoRecord; policy: RepoPolicy };
type TenantPass = { tenantId: string; deployment: LiveDeployment; openHeads: OpenHeadsReader; runs: ObservedRuns };
type LoadedRepo = EnabledRepo & (StoredPack | PolicyUnreadable) & { prs: OpenPr[]; stored: LoadedTriageState; ci: Map<string, CiState> };

/**
 * `retry` asks for another pass soon: a repository's or a tenant's pass failed, or a failed deployment is being redeployed.
 * `retryAt` is when a GitHub rate limit the pass ran into lifts; no sooner pass could read anything.
 */
export type ReconcileOutcome = { retry: boolean; retryAt?: number };

/** A failed deployment is left this long first, so a portal visit can bring one back. */
const HEAL_AFTER_MS = 2 * 60_000;
/** Failed deployments of one source in a row, within `HEAL_CAP_WINDOW_MS`, after which no more copies are made. */
const HEAL_CAP = 3;
const HEAL_CAP_WINDOW_MS = 60 * 60_000;

function failedByInterchange(deployment: DeploymentRecord): deployment is DeploymentRecord & { endedAt: Date } {
  return deployment.status === "failed" && !deployment.cancelling && deployment.endedAt !== null;
}

function enabledRepos(config: unknown, source: RepoSource): EnabledRepo[] {
  return repoRecords(triageNs(config)).flatMap(function enabled(record) {
    const policy = repoPolicy(record);
    return sourceOf(record) === source && record.connected && policy.enabled ? [{ record, policy }] : [];
  });
}

type Claimed = { rows: PrTriageRow[]; version: TriageStateVersion; enqueue: QueuedPr[] };

function headKey(row: Pick<PrTriageRow, "number" | "headSha">): string {
  return runKey(row.number, row.headSha);
}

/** Theirs in their order, each head replaced by ours only when ours is newer; heads only we have follow. */
function mergeRows(theirs: readonly PrTriageRow[], ours: readonly PrTriageRow[]): PrTriageRow[] {
  const byHead = new Map(ours.map((row) => [headKey(row), row]));
  const merged = theirs.map(function newer(row) {
    const mine = byHead.get(headKey(row));
    byHead.delete(headKey(row));
    return mine !== undefined && new Date(mine.updatedAt).getTime() > new Date(row.updatedAt).getTime() ? mine : row;
  });
  return [...merged, ...byHead.values()];
}

const BUILD_STATUS_CHANGED = "build_status_changed";

type BuildPoll = { polls: number; at: number };

/** A verdict CI decided, or is still to decide: both change when the builds do, so both are polled. */
function waitsOnCi(verdict: { checks: ReadonlyArray<{ check: string; result: string }> }): boolean {
  return verdict.checks.some((check) => check.check === "ci-green" && (check.result === "unconfirmed" || check.result === "fail"));
}

/** The verdict read its CI as cancelled, which stays so until a check is re-run; one without its rule's detail is taken as cancelled, so it is not run again and again. */
function readCancelled(verdict: { detail?: VerdictDetail | null }): boolean {
  const ciGreen = verdict.detail?.checks?.find((check) => check.check === "ci-green");
  if (ciGreen === undefined) return true;
  const values = ciGreen.output?.["values"];
  return typeof values === "object" && values !== null && "status" in values && values.status === "cancelled";
}

export function createTriageReconciler(deps: TriageReconcilerDeps) {
  /** Heads whose builds were read since their verdict; lost on restart, when the verdict's own time starts the interval again. */
  const buildPolls = new Map<string, BuildPoll>();
  /** Repositories skipped last pass and why, so the skip is logged once rather than every pass. */
  const skippedRepos = new Map<string, string>();
  /** The latest reset among the GitHub rate limits this pass ran into. */
  let limitedUntil: number | undefined;
  /** The limit last logged, so one limit is logged once rather than per repository per pass. */
  let loggedLimit: number | undefined;

  /** False for a GitHub rate limit, which is noted for the pass's outcome rather than logged and retried. */
  function reconcileFailed(entry: Record<string, unknown>, err: unknown): boolean {
    if (err instanceof GithubRateLimited) {
      limitedUntil = Math.max(limitedUntil ?? 0, err.resetAt);
      return false;
    }
    deps.log({ level: "error", msg: "triage_reconcile_failed", ...entry, error: String(err) });
    return true;
  }

  /**
   * Each tenant's last listing of each repository's open pull requests, with when it started. A failed read or a tenant
   * without a reader drops it, so a credential failure shows on the next pass; lost on restart, when every repository is listed again.
   */
  const listings = new Map<string, Map<string, { at: number; prs: OpenPr[] }>>();

  async function openPrs(pass: TenantPass, record: RepoRecord): Promise<OpenPr[]> {
    const listed = listings.get(pass.tenantId) ?? new Map<string, { at: number; prs: OpenPr[] }>();
    listings.set(pass.tenantId, listed);
    const key = `${sourceOf(record)}\n${record.name}`;
    const last = listed.get(key);
    if (last && !deps.activity.stale(pass.tenantId, sourceOf(record), record.name, last.at)) return last.prs;
    listed.delete(key);
    const at = deps.now().getTime();
    const prs = await pass.openHeads(record);
    listed.set(key, { at, prs });
    return prs;
  }

  /** The newest verdict on the head, from the live logs or as recorded, since the run that gave it may be on a released deployment. */
  function latestVerdict(pass: TenantPass, recorded: readonly VerdictRecord[], repo: string, row: PrTriageRow) {
    return [...pass.runs.verdicts, ...recorded].filter((verdict) => verdict.repo === repo && verdict.number === row.number && verdict.headSha === row.headSha).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
  }

  /** Queues a settled head whose CI the verdict waited on once its build statuses are no longer pending. */
  async function pollBuilds(pass: TenantPass, repo: LoadedRepo, plan: RepoPlan): Promise<void> {
    const name = repo.record.name;
    const now = deps.now().getTime();
    const triaged = plan.rows.filter((row) => row.status === "triaged");
    const recorded = (await deps.verdicts.latest(pass.tenantId, triaged.map((row) => ({ repo: name, number: row.number })))).filter((verdict) => verdict.source === deps.source);
    for (const row of triaged) {
      const key = `${pass.tenantId}\n${name}\n${runKey(row.number, row.headSha)}`;
      const verdict = latestVerdict(pass, recorded, name, row);
      if (!verdict || !waitsOnCi(verdict)) {
        buildPolls.delete(key);
        continue;
      }
      const poll = buildPolls.get(key) ?? { polls: 0, at: verdict.startedAt.getTime() };
      if (poll.polls >= deps.policy.maxAttempts || now - poll.at < Math.min(deps.policy.unconfirmedRetryMs * 2 ** poll.polls, deps.policy.backoffMaxMs)) continue;
      let ci: ReturnType<typeof summarizeChecks>;
      try {
        ci = summarizeChecks(await deps.headChecks(pass.tenantId, repo.record, row.headSha));
      } catch (err) {
        deps.log({ level: "warn", msg: "build_status_unread", tenantId: pass.tenantId, repo: name, pr: row.number, headSha: row.headSha, error: String(err) });
        continue;
      }
      const decided = verdict.checks.find((check) => check.check === "ci-green")!.result;
      // Cancelled CI waits on a person re-running it, however late, so its reads are not counted toward giving up.
      if (readCancelled(verdict) && ci === "cancelled") {
        buildPolls.set(key, { polls: poll.polls, at: now });
        continue;
      }
      // Pending stays pending and failed stays failed until a build changes; a red build turning green is the change worth a run.
      if (ci === "pending" || (decided === "fail" && ci === "failure")) {
        buildPolls.set(key, { polls: poll.polls + 1, at: now });
        continue;
      }
      buildPolls.delete(key);
      requeue(plan, row, BUILD_STATUS_CHANGED, deps.now(), deps.policy);
    }
  }

  /** CI of the open heads waiting for it or due as never seen, by run key; a head whose CI could not be read is left out, so it is not held. */
  async function headsCi(tenantId: string, record: RepoRecord, prs: readonly OpenPr[], rows: readonly PrTriageRow[]): Promise<Map<string, CiState>> {
    const byHead = new Map(rows.map((row) => [headKey(row), row]));
    const now = deps.now().getTime();
    const ci = new Map<string, CiState>();
    for (const pr of prs) {
      const key = runKey(pr.number, pr.headSha);
      const status = byHead.get(key)?.status ?? "new";
      if (status !== "waiting" && !(status === "new" && now - new Date(pr.updatedAt).getTime() >= deps.policy.webhookGraceMs)) continue;
      try {
        ci.set(key, summarizeChecks(await deps.headChecks(tenantId, record, pr.headSha)));
      } catch (err) {
        deps.log({ level: "warn", msg: "waiting_checks_unread", tenantId, repo: record.name, pr: pr.number, headSha: pr.headSha, error: String(err) });
      }
    }
    return ci;
  }

  async function loadRepo(pass: TenantPass, repo: EnabledRepo): Promise<LoadedRepo | undefined> {
    const read = await deps.readCheckPack(pass.tenantId, repo.record.name, sourceOf(repo.record));
    const pauseLabel = read.status === "ok" ? read.pauseLabel : undefined;
    // A paused pull request is left out like a draft, so its rows go and nothing retries it until its label comes off.
    const prs = (await openPrs(pass, repo.record)).filter((pr) => !pr.draft && !(pauseLabel !== undefined && pr.labels?.includes(pauseLabel)));
    // Without a policy, or with every rule off, triage has nothing to decide: no run starts and nothing is written to the pull request.
    const key = `${pass.tenantId}\n${repo.record.name}`;
    if (read.status === "ok" && hasEnabledRules(read.pack)) {
      skippedRepos.delete(key);
      const stored = await deps.store.load(pass.tenantId, triageStateKey(repo.record));
      const ci = dependsOnCi(read.pack) ? await headsCi(pass.tenantId, repo.record, prs, stored.rows) : new Map<string, CiState>();
      return { ...repo, pack: read.pack, automatic: read.automatic, source: read.source, ...(read.policyWorkflow && { policyWorkflow: read.policyWorkflow }), ...(read.pauseLabel && { pauseLabel: read.pauseLabel }), prs, stored, ci };
    }
    // A policy triage can't read is mailed in place of a pack, so every open head is marked failed.
    if (read.status === "invalid" || read.status === "corrupt") {
      skippedRepos.delete(key);
      return { ...repo, policyUnreadable: read.reason, automatic: read.automatic, prs, stored: await deps.store.load(pass.tenantId, triageStateKey(repo.record)), ci: new Map<string, CiState>() };
    }
    const skipped = read.status === "ok" ? "triage_skipped_no_rules" : "triage_skipped_no_policy";
    // Once per repository, and again only once a policy or rule came and went, so a repository left unset stays quiet.
    if (skippedRepos.get(key) !== skipped) deps.log({ level: "info", msg: skipped, tenantId: pass.tenantId, repo: repo.record.name, pulls: prs.map((pr) => pr.number) });
    skippedRepos.set(key, skipped);
    return undefined;
  }

  /**
   * Writes the plan's queued heads before any mail goes out, so a request
   * arriving meanwhile sees them queued. When someone wrote first, their rows
   * are reloaded and a head they already queued or started is left to them;
   * refused again, nothing is mailed this pass.
   */
  async function claim(tenantId: string, repo: string, stored: LoadedTriageState, plan: RepoPlan): Promise<Claimed | undefined> {
    const claimed = { rows: plan.rows, version: stored.version, enqueue: plan.enqueue };
    if (JSON.stringify(plan.rows) === JSON.stringify(stored.rows)) return claimed;
    try {
      return { ...claimed, version: await deps.store.save(tenantId, repo, plan.rows, stored.version) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
    const fresh = await deps.store.load(tenantId, repo);
    const theirs = new Map(fresh.rows.map((row) => [headKey(row), row]));
    const headOf = (queued: QueuedPr) => headKey(plan.rows.find((row) => row.number === queued.number)!);
    const left = new Set(plan.enqueue.map(headOf).filter((key) => theirs.has(key) && inFlight(theirs.get(key)!)));
    const rows = mergeRows(fresh.rows, plan.rows.filter((row) => !left.has(headKey(row))));
    try {
      const version = await deps.store.save(tenantId, repo, rows, fresh.version);
      deps.log({ level: "info", msg: "triage_state_merged", tenantId, repo, left: left.size });
      return { rows, version, enqueue: plan.enqueue.filter((queued) => !left.has(headOf(queued))) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
      deps.log({ level: "warn", msg: "triage_state_conflict", tenantId, repo });
      return undefined;
    }
  }

  /** Mails the heads this pass started holding for CI to be marked waiting. */
  async function markHeld(pass: TenantPass, repo: LoadedRepo, rows: readonly PrTriageRow[]): Promise<void> {
    if (!("pack" in repo) || !marksWaiting(sourceOf(repo.record), repo.automatic)) return;
    const waited = new Set(repo.stored.rows.filter((row) => row.status === "waiting").map(headKey));
    for (const row of rows.filter((candidate) => candidate.status === "waiting" && !waited.has(headKey(candidate)))) {
      await deps.send({ tenantId: pass.tenantId, workflow: triageWorkflowFor(deps.source).id, repo: triageStateKey(repo.record), number: row.number, headSha: row.headSha, source: "reconcile", payload: waitingPayload(repo.record, repo.policy, repo, row, false) });
    }
  }

  async function deliverRepo(pass: TenantPass, repo: LoadedRepo, plan: RepoPlan): Promise<void> {
    const key = triageStateKey(repo.record);
    const claimed = await claim(pass.tenantId, key, repo.stored, plan);
    if (claimed === undefined) return;
    await markHeld(pass, repo, claimed.rows);
    const headShaOf = (queued: QueuedPr) => claimed.rows.find((row) => row.number === queued.number)!.headSha;
    // A head that waited for CI carries the events it waited with.
    for (const queued of claimed.enqueue) {
      const headSha = headShaOf(queued);
      const extra = queued.events === undefined
        ? { items: [{ prNumber: queued.number, headSha, ...(queued.judged && { judged: queued.judged }) }] }
        : { prNumber: queued.number, headSha, events: queued.events };
      const mailed = { ...extra, ...(queued.noWait && { noWait: true }) };
      const payload = "pack" in repo ? mailPayload(repo.record, repo.policy, repo, mailed) : unreadablePayload(repo.record, repo.policy, repo, mailed);
      try {
        await deps.send({ tenantId: pass.tenantId, workflow: triageWorkflowFor(deps.source).id, repo: key, number: queued.number, headSha, source: "reconcile", record: repo.record, payload });
      } catch (err) {
        if (err instanceof GithubRateLimited) throw err;
        deps.log({ level: "error", msg: "forward_failed", tenantId: pass.tenantId, repo: repo.record.name, pr: queued.number, headSha, error: String(err) });
        await failHead(deps.store, { tenantId: pass.tenantId, repo: key, number: queued.number, headSha }, `delivery failed: ${String(err)}`, deps.now());
        continue;
      }
      deps.log({ level: "info", msg: "triage_requeued", tenantId: pass.tenantId, repo: repo.record.name, pr: queued.number, headSha, reason: queued.reason });
    }
  }

  /**
   * Keeps a recorded rotation, or drops it, and returns the deployment to
   * mail: the copy while the rotation stands. The replaced deployment gets no
   * new mail; it is released once its heads settled and mail it was sent has
   * had time to start, or once a head still running there counts as stuck and
   * is queued again on the copy. A deployment newer than the replaced one
   * that the hub did not make, such as the portal's of a new version,
   * supersedes the copy, which is released. The record is dropped once the
   * replaced deployment or the copy is gone, the copy is being cancelled, or
   * the copy is superseded.
   */
  async function settle(tenantId: string, record: RotationRecord, deployments: readonly LiveDeployment[], runningOn: ReadonlySet<string>, now: Date): Promise<LiveDeployment | undefined> {
    const from = deployments.find((live) => live.runId === record.from);
    const copy = deployments.find((live) => live.runId === record.to);
    const superseded = from !== undefined && deployments.some(function newer(live) {
      return live.runId !== record.from && live.runId !== record.to && !live.cancelling && live.createdAt > from.createdAt;
    });
    if (copy !== undefined && !copy.cancelling && superseded) {
      await deps.rotation.release(tenantId, copy.runId);
      deps.log({ level: "info", msg: "triage_rotation_superseded", tenantId, deployment: record.from, copy: copy.runId });
    }
    if (from === undefined || copy === undefined || copy.cancelling || superseded) {
      await deps.rotation.clear(tenantId, record);
      return newestLive(superseded ? deployments.filter((live) => live.runId !== record.to) : deployments);
    }
    const since = now.getTime() - copy.createdAt.getTime();
    const quiet = !runningOn.has(from.runId) && since >= deps.policy.unstartedAfterMs;
    if (!from.cancelling && (quiet || since > deps.policy.stuckAfterMs)) {
      await deps.rotation.release(tenantId, from.runId);
      deps.log({ level: "info", msg: "triage_deployment_released", tenantId, deployment: from.runId, replacedBy: copy.runId });
    }
    return copy;
  }

  /**
   * Two live deployments of the same source with no rotation recorded are a
   * rotation whose record was never written, or a portal redeploy whose cancel
   * of the older one failed; the newer is recorded as the older one's copy so
   * the older one is retired like any replaced deployment.
   */
  async function adopt(tenantId: string, deployments: readonly LiveDeployment[], now: Date): Promise<RotationRecord | undefined> {
    if (deployments.length !== 2 || deployments.some((live) => live.cancelling)) return undefined;
    const [newer, older] = deployments as [LiveDeployment, LiveDeployment];
    if (!await deps.rotation.sameSource(older.runId, newer.runId)) return undefined;
    const record = { from: older.runId, to: newer.runId, at: now.toISOString() };
    if (!await deps.rotation.claim(tenantId, record)) return undefined;
    deps.log({ level: "info", msg: "triage_rotation_adopted", tenantId, deployment: older.runId, copy: newer.runId });
    return record;
  }

  /**
   * Returns the deployment this pass mails. The only live deployment is
   * replaced by a copy once its log holds more than `afterRuns` runs; the
   * rotation is recorded before the copy is mailed, so a later pass, even
   * after a restart, releases only what the record names.
   */
  async function route(tenant: ReconcileTenant, deployments: readonly LiveDeployment[], observed: readonly ObservedRuns[]): Promise<LiveDeployment | undefined> {
    const now = deps.now();
    const runningOn = new Set(deployments.filter((_live, index) => isRunning(observed[index]!)).map((live) => live.runId));
    const recorded = rotationRecord(triageNs(tenant.config), deps.rotationKey);
    if (recorded) return settle(tenant.id, recorded, deployments, runningOn, now);
    const adopted = await adopt(tenant.id, deployments, now);
    if (adopted) return settle(tenant.id, adopted, deployments, runningOn, now);
    const newest = newestLive(deployments);
    const runCount = observed[0]!.runCount;
    if (deployments.length !== 1 || newest === undefined || runCount <= deps.rotation.afterRuns) return newest;
    // A deployment made while this pass ran, such as the portal's of a newer version, must not be replaced by a copy of the one it superseded.
    const current = await deps.liveDeployments(tenant.id);
    if (current.length !== 1 || current[0]!.runId !== newest.runId || current[0]!.cancelling) {
      deps.log({ level: "info", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: "deployments_changed" });
      return newestLive(current);
    }
    const redeployed = await deps.rotation.redeploy(tenant.id, newest.runId);
    if (redeployed.status === "skipped") {
      deps.log({ level: "warn", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: redeployed.reason });
      return newest;
    }
    const record = { from: newest.runId, to: redeployed.runId, at: now.toISOString() };
    if (!await deps.rotation.claim(tenant.id, record)) {
      await deps.rotation.release(tenant.id, redeployed.runId);
      deps.log({ level: "warn", msg: "triage_rotation_skipped", tenantId: tenant.id, deployment: newest.runId, reason: "rotation_recorded" });
      return newest;
    }
    deps.log({ level: "info", msg: "triage_deployment_rotated", tenantId: tenant.id, deployment: newest.runId, replacedBy: redeployed.runId, runs: runCount });
    const after = await deps.liveDeployments(tenant.id);
    return settle(tenant.id, record, after, runningOn, now);
  }

  /** The newest `HEAL_CAP` failed within the window, from the same source. */
  async function healCapped(latest: readonly DeploymentRecord[], now: number): Promise<boolean> {
    if (latest.length < HEAL_CAP) return false;
    if (!latest.every((deployment) => failedByInterchange(deployment) && now - deployment.endedAt.getTime() < HEAL_CAP_WINDOW_MS)) return false;
    for (const older of latest.slice(1)) {
      if (!await deps.rotation.sameSource(latest[0]!.runId, older.runId)) return false;
    }
    return true;
  }

  /**
   * With no live deployment, the newest one is deployed again from its launch
   * spec when Interchange failed it, rather than someone cancelling it. True
   * when a pass soon is worth it: the failure is still recent, a copy was just
   * made and its sidecar is starting, or the host had no room for it yet.
   */
  async function heal(tenantId: string): Promise<boolean> {
    const latest = await deps.latestDeployments(tenantId, HEAL_CAP);
    const failed = latest[0];
    if (failed === undefined || !failedByInterchange(failed)) return false;
    const now = deps.now().getTime();
    if (now - failed.endedAt.getTime() < HEAL_AFTER_MS) return true;
    if (await healCapped(latest, now)) {
      deps.log({ level: "warn", msg: "triage_heal_capped", tenantId, deployment: failed.runId });
      return false;
    }
    // The portal may have deployed while this pass read; a copy of the old source would then outrank it.
    if ((await deps.liveDeployments(tenantId)).length > 0) return true;
    let redeployed: Redeployed;
    try {
      redeployed = await deps.rotation.redeploy(tenantId, failed.runId);
    } catch (error) {
      const full = error instanceof WorkflowProvisioningError && error.code === CAPACITY_UNAVAILABLE;
      deps.log({ level: "warn", msg: full ? "triage_heal_deferred" : "triage_heal_skipped", tenantId, deployment: failed.runId, reason: String(error) });
      return full;
    }
    if (redeployed.status === "skipped") {
      deps.log({ level: "warn", msg: "triage_heal_skipped", tenantId, deployment: failed.runId, reason: redeployed.reason });
      return false;
    }
    deps.log({ level: "info", msg: "triage_deployment_healed", tenantId, deployment: failed.runId, replacedBy: redeployed.runId });
    return true;
  }

  /** True when the pass is worth repeating soon: a repository's pass failed, or a failed deployment is being redeployed. */
  async function reconcileTenant(tenant: ReconcileTenant): Promise<boolean> {
    const repos = enabledRepos(tenant.config, deps.source);
    if (repos.length === 0) return false;
    // Only live deployments' and recent workers' logs are read; heads triaged under a released one stay settled in the stored state until the live deployment runs another workflow version.
    const { deployments, observed, workers } = await deps.observeTenant(tenant.id, tenant.domain);
    if (deployments.length === 0) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return heal(tenant.id);
    }
    let openHeads: OpenHeadsReader | undefined;
    try {
      openHeads = await deps.openHeadsFor(tenant.id);
    } catch (err) {
      listings.delete(tenant.id);
      throw err;
    }
    if (!openHeads) {
      listings.delete(tenant.id);
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_source_credential" });
      return false;
    }
    const runs = mergeObservedRuns([...observed, ...workers]);
    let deployment = newestLive(deployments);
    try {
      deployment = await route(tenant, deployments, observed);
    } catch (err) {
      deps.log({ level: "error", msg: "triage_rotation_failed", tenantId: tenant.id, error: String(err) });
    }
    if (!deployment) {
      deps.log({ level: "warn", msg: "triage_reconcile_skipped", tenantId: tenant.id, reason: "no_live_deployment" });
      return false;
    }
    const managed = await deps.managerRuns(tenant.id, deps.source, deployment.workflowVersion);
    const pass: TenantPass = { tenantId: tenant.id, deployment, openHeads, runs: mergeObservedRuns([runs, managed]) };
    const loaded: LoadedRepo[] = [];
    let failed = false;
    for (const repo of repos) {
      try {
        const repoLoaded = await loadRepo(pass, repo);
        if (repoLoaded) loaded.push(repoLoaded);
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id, repo: repo.record.name }, err)) failed = true;
      }
    }
    const plans = planTenant({
      repos: loaded.map((repo) => ({ name: repo.record.name, prs: repo.prs, rows: repo.stored.rows, ci: repo.ci })),
      runs: pass.runs.byRepo,
      now: deps.now(),
      policy: deps.policy,
      workflowVersion: pass.deployment.workflowVersion,
      offeringId: pass.deployment.offeringId,
    });
    for (const repo of loaded) {
      try {
        await pollBuilds(pass, repo, plans.get(repo.record.name)!);
        await deliverRepo(pass, repo, plans.get(repo.record.name)!);
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id, repo: repo.record.name }, err)) failed = true;
      }
    }
    return failed;
  }

  return async function reconcileTriage(): Promise<ReconcileOutcome> {
    let retry = false;
    limitedUntil = undefined;
    for (const tenant of await deps.tenants()) {
      try {
        if (await reconcileTenant(tenant)) retry = true;
      } catch (err) {
        if (reconcileFailed({ tenantId: tenant.id }, err)) retry = true;
      }
    }
    if (limitedUntil === undefined) return { retry };
    if (limitedUntil !== loggedLimit) deps.log({ level: "warn", msg: "triage_github_rate_limited", resetAt: new Date(limitedUntil).toISOString() });
    loggedLimit = limitedUntil;
    return { retry, retryAt: limitedUntil };
  };
}
