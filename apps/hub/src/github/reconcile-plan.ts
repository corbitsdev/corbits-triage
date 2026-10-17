// Decides, from what GitHub and the run logs say now, which open pull requests
// to queue again. Pure, so every recovery path is decided in one place.
import { PR_TRIAGE_STUCK_RUN_MS, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import type { CiState } from "@corbits/github-reads";
import { MODEL_NOT_ASKED } from "@corbits/triage-workflows/logic/settled";
import type { Judged } from "@corbits/triage-workflows/logic/item";

export type OpenPr = { number: number; headSha: string; updatedAt: string; draft: boolean };

export type ObservedRun = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  /** Why a completed run does not settle the head: no verdict, a degraded one, one made on another commit, with unconfirmed checks or without asking the decision model. */
  unsettled?: string;
  /** The verdict only waits on GitHub for a machine check, so the head is retried after `unconfirmedRetryMs` rather than at once. */
  unconfirmed?: true;
  /** Workflow package version of the deployment the run ran on; the row keeps it to reset failed heads on a later deployment and to carry judge answers. */
  workflowVersion?: string;
  trigger?: string;
  offeringId?: string;
  judged?: Judged;
};

export type ReconcilePolicy = {
  /** A pull request this recently updated may still have its webhook run on the way. */
  webhookGraceMs: number;
  /** A queued run that has not started by then was lost before it reached the sidecar. */
  unstartedAfterMs: number;
  /** A run still going after this long lost its sidecar. */
  stuckAfterMs: number;
  /** How far the sidecar clock may trail the hub's when matching a run to the hub's queue time. */
  clockSkewMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  maxAttempts: number;
  /** A head capped by runs that never started gets a fresh set of attempts this long after it was capped. */
  cappedRetryAfterMs: number;
  /** Fresh sets of attempts such a head gets before it stays capped. */
  cappedRetryCycles: number;
  /** A verdict waiting only on GitHub, such as mergeability not computed yet, is retried no sooner than this after its run. */
  unconfirmedRetryMs: number;
  /** A head the base branch moved under is queued again no sooner than this after it was last queued, so a run of merges re-checks it once per window instead of once per merge. */
  baseMoveWindowMs: number;
  /** Heads a tenant has queued or running at once; further due heads wait, never-triaged ones first, then oldest waiting first. */
  maxInFlight: number;
  /** A head whose policy reads CI waits at most this long, from when it was first seen, for CI to finish. */
  ciWaitMaxMs: number;
  /** A head with no checks yet is taken as having no CI once it was first seen this long ago. */
  ciStartGraceMs: number;
};

const MINUTE = 60_000;

export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  webhookGraceMs: 2 * MINUTE,
  unstartedAfterMs: 10 * MINUTE,
  stuckAfterMs: PR_TRIAGE_STUCK_RUN_MS,
  clockSkewMs: MINUTE,
  backoffBaseMs: 5 * MINUTE,
  backoffMaxMs: 6 * 60 * MINUTE,
  maxAttempts: 5,
  cappedRetryAfterMs: 6 * 60 * MINUTE,
  cappedRetryCycles: 3,
  unconfirmedRetryMs: 5 * MINUTE,
  baseMoveWindowMs: 15 * MINUTE,
  maxInFlight: 5,
  ciWaitMaxMs: 60 * MINUTE,
  ciStartGraceMs: 2 * MINUTE,
};

/** A head waits while its CI is running, or has not started yet, within its bounds; a failed check ends the wait, and so does CI that could not be read. */
export function waitsForCi(ci: CiState | undefined, firstSeenAt: string, now: Date, policy: Pick<ReconcilePolicy, "ciWaitMaxMs" | "ciStartGraceMs">): boolean {
  const waited = now.getTime() - new Date(firstSeenAt).getTime();
  if (ci === "pending") return waited < policy.ciWaitMaxMs;
  return ci === "none" && waited < policy.ciStartGraceMs;
}

type RepoPlanInput = {
  name: string;
  prs: readonly OpenPr[];
  rows: readonly PrTriageRow[];
  /** CI of the repository's waiting heads and due new ones, by run key, when its policy reads CI; a head left out is not held. */
  ci?: ReadonlyMap<string, CiState>;
};

export type TenantPlanInput = {
  repos: readonly RepoPlanInput[];
  /** Every observed run of the deployment, by repository, then by `${number}@${headSha}`, whether or not its repository or head is still here. */
  runs: ReadonlyMap<string, ReadonlyMap<string, readonly ObservedRun[]>>;
  now: Date;
  policy: ReconcilePolicy;
  /** Workflow package version of the deployment new mail goes to; none when it was not deployed from the package registry. */
  workflowVersion: string | undefined;
  /** Decision-model offering of the deployment new mail goes to; judge answers are carried only between runs on the same one. */
  offeringId?: string;
};

/** A head to queue, why, the judge answers its earlier runs got, and the events it waited on CI with. */
export type QueuedPr = { number: number; reason: string; judged?: Judged; events?: TriageEvent[] };

/** Rows for exactly the open heads; queued heads are already marked queued. */
export type RepoPlan = { rows: PrTriageRow[]; enqueue: QueuedPr[] };

export function runKey(number: number, headSha: string): string {
  return `${number}@${headSha}`;
}

export function runKeyNumber(key: string): number {
  return Number(key.slice(0, key.indexOf("@")));
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

function backoffMs(attempts: number, policy: ReconcilePolicy): number {
  if (attempts === 0) return 0;
  return Math.min(policy.backoffBaseMs * 2 ** (attempts - 1), policy.backoffMaxMs);
}

type Observation = { status: PrTriageRow["status"]; run?: ObservedRun; runId?: string; error?: string };

function withStatus(row: PrTriageRow, { status, run, runId = run?.runId, error }: Observation, now: string): PrTriageRow {
  const workflowVersion = run?.workflowVersion ?? row.workflowVersion;
  if (row.status === status && row.runId === runId && row.error === error && row.workflowVersion === workflowVersion) return row;
  const { runId: _run, error: _error, workflowVersion: _version, events, ...rest } = row;
  return {
    ...rest,
    status,
    ...(events !== undefined && inFlight({ status }) && { events }),
    ...(runId !== undefined && { runId }),
    ...(error !== undefined && { error }),
    ...(workflowVersion !== undefined && { workflowVersion }),
    updatedAt: now,
  };
}

function failure(run: ObservedRun, stuck: boolean): string {
  if (stuck) return "run stuck";
  return run.unsettled ?? `run ${run.status}`;
}

export function isStuck(run: ObservedRun, now: Date, policy: ReconcilePolicy): boolean {
  return run.status === "running" && now.getTime() - ms(run.startedAt) > policy.stuckAfterMs;
}

/** The run the row already names wins; otherwise the newest. */
function pick(row: PrTriageRow, runs: readonly ObservedRun[]): ObservedRun | undefined {
  return runs.find((run) => run.runId === row.runId) ?? [...runs].sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
}

/** Runs started since the hub last queued the head, allowing for the sidecar clock trailing the hub's. */
function sinceQueued(row: PrTriageRow, runs: readonly ObservedRun[], policy: ReconcilePolicy): ObservedRun[] {
  const since = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt) - policy.clockSkewMs;
  return runs.filter((run) => ms(run.startedAt) >= since);
}

export const BASE_MOVED = "base branch moved";

/**
 * Runs started since the base branch last moved under the head, allowing for the sidecar clock trailing the hub's; all of them when it never did.
 * The allowance cuts both ways: a run that really started up to `clockSkewMs` before the move still counts as current, accepted so a
 * post-move run on a trailing clock is never re-run forever.
 */
function sinceStale(row: PrTriageRow, runs: readonly ObservedRun[], policy: ReconcilePolicy): readonly ObservedRun[] {
  const stale = row.staleBefore;
  return stale === undefined ? runs : runs.filter((run) => ms(run.startedAt) >= ms(stale) - policy.clockSkewMs);
}

/**
 * A clean completed run settles the head; otherwise a run still going keeps it
 * running; only once every run has ended does the failure of the one since the
 * hub last queued the head count. A head queued or running on the hub's word
 * only sees runs since it was queued, so a head queued again on top of a
 * verdict stays queued until its new run starts. Runs from before the base
 * branch last moved settle nothing; one of them in flight holds the head
 * until it ends, and the head is stale then.
 */
function observe(row: PrTriageRow, observed: readonly ObservedRun[], now: Date, policy: ReconcilePolicy): PrTriageRow {
  // A waiting head's earlier verdicts are older than the events it holds; only its CI releases it.
  if (row.status === "waiting") return row;
  const at = now.toISOString();
  const waiting = row.status === "queued" || row.status === "running";
  const current = sinceStale(row, observed, policy);
  const runs = waiting ? sinceQueued(row, current, policy) : current;
  const settled = runs.find((run) => run.status === "completed" && run.unsettled === undefined);
  if (settled) return withStatus(row, { status: "triaged", run: settled }, at);
  const live = pick(row, runs.filter((run) => run.status === "running" && !isStuck(run, now, policy)));
  if (live) return withStatus(row, { status: "running", run: live }, at);
  if (waiting) {
    // A run the base branch moved under keeps its slot until it ends; its verdict is outdated, so the head is due again then.
    const outdated = sinceQueued(row, observed, policy).filter((run) => !current.includes(run));
    const still = pick(row, outdated.filter((run) => run.status === "running" && !isStuck(run, now, policy)));
    if (still) return withStatus(row, { status: "running", run: still }, at);
    if (outdated.length > 0) return withStatus(row, { status: "stale", runId: row.runId, error: BASE_MOVED }, at);
  }
  const ended = pick(row, sinceQueued(row, runs, policy));
  if (ended) {
    const failed = withStatus(row, { status: "failed", run: ended, error: failure(ended, isStuck(ended, now, policy)) }, at);
    return row.status === "triaged" && ended.unsettled === MODEL_NOT_ASKED ? { ...failed, attempts: 0 } : failed;
  }
  if (row.status === "queued" && row.queuedAt !== undefined && now.getTime() - ms(row.queuedAt) > policy.unstartedAfterMs) {
    return withStatus(row, { status: "failed", error: NEVER_STARTED }, at);
  }
  if (row.status === "running" && now.getTime() - ms(row.updatedAt) > policy.stuckAfterMs) {
    return withStatus(row, { status: "failed", runId: row.runId, error: "run lost" }, at);
  }
  return row;
}

const NEVER_STARTED = "run never started";

function uncapped(row: PrTriageRow, now: Date, policy: ReconcilePolicy): PrTriageRow {
  if (row.status !== "failed" || row.attempts < policy.maxAttempts || row.error !== NEVER_STARTED) return row;
  const cycles = row.cappedRetries ?? 0;
  if (cycles >= policy.cappedRetryCycles || now.getTime() - ms(row.updatedAt) < policy.cappedRetryAfterMs) return row;
  return { ...row, attempts: 0, cappedRetries: cycles + 1 };
}

function isDue(row: PrTriageRow, pr: OpenPr, runs: readonly ObservedRun[], ci: CiState | undefined, now: Date, policy: ReconcilePolicy): boolean {
  if (row.status === "waiting") return !waitsForCi(ci, row.firstSeenAt, now, policy);
  if (row.status === "stale") return row.queuedAt === undefined || now.getTime() - ms(row.queuedAt) >= policy.baseMoveWindowMs;
  if (row.status === "new") return now.getTime() - ms(pr.updatedAt) >= policy.webhookGraceMs;
  if (row.status !== "failed" || row.attempts >= policy.maxAttempts) return false;
  const last = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt);
  const verdict = runs.find((run) => run.runId === row.runId);
  const unconfirmedUntil = verdict?.unconfirmed ? ms(verdict.startedAt) + policy.unconfirmedRetryMs : -Infinity;
  return now.getTime() >= Math.max(last + backoffMs(row.attempts, policy), unconfirmedUntil);
}

const STALE_VERDICT = "attempts from workflow version";

/** A head capped under another workflow version starts over, once: its attempts were spent on other code. A settled verdict is kept; the next event triages the head on the current version. A row that names no version is not stale; a legacy integer always differs. */
function fresh(pr: OpenPr, prior: PrTriageRow | undefined, workflowVersion: string | undefined, at: string): PrTriageRow {
  if (prior === undefined) {
    return { number: pr.number, headSha: pr.headSha, status: "new", attempts: 0, ...(workflowVersion !== undefined && { workflowVersion }), firstSeenAt: at, updatedAt: at };
  }
  if (workflowVersion === undefined || prior.workflowVersion === undefined || prior.workflowVersion === workflowVersion) return prior;
  if (prior.status !== "failed") return prior;
  const { runId: _run, queuedAt: _queued, ...rest } = prior;
  return { ...rest, status: "new", attempts: 0, workflowVersion, error: `${STALE_VERDICT} ${prior.workflowVersion}, current is ${workflowVersion}`, updatedAt: at };
}

/** A queued head counts until the hub marks it failed for never starting, so a backed-up queue is not mailed again. */
export function inFlight(row: Pick<PrTriageRow, "status">): boolean {
  return row.status === "queued" || row.status === "running";
}

/**
 * Heads the deployment is still running, by repository and run key: the slot is
 * held whether or not the head is still open, its pull request still enabled
 * or its repository loaded this pass.
 */
function runningHeads(runs: TenantPlanInput["runs"], now: Date, policy: ReconcilePolicy): Set<string> {
  const busy = new Set<string>();
  for (const [repo, byHead] of runs) {
    for (const [key, observed] of byHead) {
      if (observed.some((run) => run.status === "running" && !isStuck(run, now, policy))) busy.add(`${repo} ${key}`);
    }
  }
  return busy;
}

/** Once a head is on the live version, a run of any other, such as one on a deployment still being cancelled, neither settles nor fails it; it still holds its slot. A head still on an older version keeps every run, so one in flight settles. */
function counts(run: ObservedRun, row: PrTriageRow, workflowVersion: string | undefined): boolean {
  return workflowVersion === undefined || row.workflowVersion !== workflowVersion || run.workflowVersion === workflowVersion;
}

type Due = { repo: string; index: number; row: PrTriageRow; judged: Judged };

/**
 * Every answer the head's completed runs got on the same workflow version and decision-model offering as the
 * deployment mailed, a newer run's winning; none when either is unknown. The judge is asked only what none answered.
 */
function judgedOf(runs: readonly ObservedRun[], workflowVersion: string | undefined, offeringId: string | undefined): Judged {
  if (workflowVersion === undefined || offeringId === undefined) return {};
  const done = runs
    .filter((run) => run.status === "completed" && run.workflowVersion === workflowVersion && run.offeringId === offeringId)
    .sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  return Object.assign({}, ...done.map((run) => run.judged ?? {}));
}

/** A head with no run and no verdict, even if its mail failed to deliver; a version-stale reset also has no run, so only its reason tells it apart. */
function neverTriaged(row: PrTriageRow): boolean {
  return row.status === "new" && row.runId === undefined && !row.error?.startsWith(STALE_VERDICT);
}

/** Never-attempted heads first, then oldest waiting first, a retried head by the time it was last queued; among equals, the oldest pull request first. */
function byWait(a: Due, b: Due): number {
  return Number(neverTriaged(b.row)) - Number(neverTriaged(a.row))
    || ms(a.row.queuedAt ?? a.row.firstSeenAt) - ms(b.row.queuedAt ?? b.row.firstSeenAt)
    || a.row.number - b.row.number;
}

/** Queues a settled head again for `reason`, as a due one is; the row keeps its run so the verdict's answers are carried. */
export function requeue(plan: RepoPlan, row: PrTriageRow, reason: string, now: Date): void {
  const index = plan.rows.findIndex((candidate) => candidate.number === row.number && candidate.headSha === row.headSha);
  if (index === -1) return;
  const at = now.toISOString();
  const { runId: _run, error: _error, events: _events, ...rest } = row;
  plan.rows[index] = { ...rest, status: "queued", attempts: row.attempts + 1, queuedAt: at, updatedAt: at };
  plan.enqueue.push({ number: row.number, reason });
}

/** Queues due heads across the tenant's repositories, never-triaged ones first, while fewer than `maxInFlight` heads are queued or running. */
export function planTenant({ repos, runs, now, policy, workflowVersion, offeringId }: TenantPlanInput): Map<string, RepoPlan> {
  const at = now.toISOString();
  const plans = new Map<string, RepoPlan>();
  const due: Due[] = [];
  const busy = runningHeads(runs, now, policy);
  for (const { name, prs, rows, ci } of repos) {
    const byHead = new Map(rows.map((row) => [runKey(row.number, row.headSha), row]));
    const observed = runs.get(name);
    const next: PrTriageRow[] = [];
    for (const pr of prs) {
      const key = runKey(pr.number, pr.headSha);
      const current = fresh(pr, byHead.get(key), workflowVersion, at);
      const runsOfHead = (observed?.get(key) ?? []).filter((run) => counts(run, current, workflowVersion));
      const seen = uncapped(observe(current, runsOfHead, now, policy), now, policy);
      // A head no webhook queued waits for its running CI like one that did; one with no checks yet is taken as having none.
      const held = seen.status === "new" && ci?.get(key) === "pending" && isDue(seen, pr, runsOfHead, undefined, now, policy) && waitsForCi("pending", seen.firstSeenAt, now, policy);
      const row: PrTriageRow = held ? { ...seen, status: "waiting", updatedAt: at } : seen;
      if (inFlight(row)) busy.add(`${name} ${key}`);
      if (isDue(row, pr, runsOfHead, ci?.get(key), now, policy)) due.push({ repo: name, index: next.length, row, judged: judgedOf(runsOfHead, workflowVersion, offeringId) });
      next.push(row);
    }
    plans.set(name, { rows: next, enqueue: [] });
  }
  for (const { repo, index, row, judged } of due.sort(byWait).slice(0, Math.max(policy.maxInFlight - busy.size, 0))) {
    const plan = plans.get(repo)!;
    const { runId: _run, error: _error, events, ...rest } = row;
    // The events stay on the row while its run is in flight, so a check run finishing meanwhile is known to be covered by it.
    plan.rows[index] = { ...rest, status: "queued", ...(events !== undefined && { events }), attempts: row.attempts + 1, queuedAt: at, updatedAt: at };
    const reason = row.status === "waiting" ? "waited for CI" : row.error ?? "never triaged";
    plan.enqueue.push({ number: row.number, reason, ...(Object.keys(judged).length > 0 && { judged }), ...(events !== undefined && { events }) });
  }
  return plans;
}
