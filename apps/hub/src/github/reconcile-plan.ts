// Decides, from what the host and the managers' runs say now, which open pull
// requests to queue again. Pure, so every recovery path is decided in one place.
import { PR_TRIAGE_STUCK_RUN_MS, type AwaitedStage, type PrTriageRow, type RepoSource, type TriageEvent } from "@corbits/triage-contracts";
import type { CiState } from "@corbits/github-reads";
import { MODEL_NOT_ASKED } from "@corbits/triage-workflows/logic/settled";

/** `labels` only where the host lists them. */
export type OpenPr = { number: number; headSha: string; updatedAt: string; draft: boolean; labels?: string[] };

export type ObservedRun = {
  runId: string;
  /** The host its mail named. */
  source: RepoSource;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  /** Why a completed run does not settle the head: no verdict, a degraded one, one made on another commit, with unconfirmed checks or without asking the decision model. */
  unsettled?: string;
  /** The verdict only waits on GitHub for a machine check, so the head is retried after `unconfirmedRetryMs` rather than at once. */
  unconfirmed?: true;
  /** The run waited for CI still running on the head instead of deciding, so the head waits for its CI. */
  heldForCi?: true;
  trigger?: string;
  /** When a running manager took the pass it has open; absent while it is up between passes, as while it waits on a reviewer. */
  passAt?: string;
  /** What a running manager's reviewers on its head have yet to report. */
  awaiting?: AwaitedStage[];
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

/** Past the CI wait the hub waits no longer for the host's checks, so the head is decided even while they are pending. */
export function waitedOut(firstSeenAt: string, now: Date, policy: Pick<ReconcilePolicy, "ciWaitMaxMs">): boolean {
  return now.getTime() - ms(firstSeenAt) >= policy.ciWaitMaxMs;
}

/** A run on a head's last attempt is decided too, so the head never ends without a verdict; so is one past the CI wait. `attempts` is the count the queued run leaves on the row. */
function decideNow(row: PrTriageRow, attempts: number, now: Date, policy: ReconcilePolicy): boolean {
  return waitedOut(row.firstSeenAt, now, policy) || attempts >= policy.maxAttempts;
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
  /** Every observed run, by repository, then by `${number}@${headSha}`, whether or not its repository or head is still here. */
  runs: ReadonlyMap<string, ReadonlyMap<string, readonly ObservedRun[]>>;
  now: Date;
  policy: ReconcilePolicy;
};

/** A head to queue, why, the events it waited on CI with, and whether it is decided while the host's checks are pending. */
export type QueuedPr = { number: number; reason: string; events?: TriageEvent[]; noWait?: true };

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
  if (row.status === status && row.runId === runId && row.error === error) return row;
  const { runId: _run, error: _error, events, ...rest } = row;
  return {
    ...rest,
    status,
    ...(events !== undefined && (inFlight({ status }) || status === "waiting") && { events }),
    ...(runId !== undefined && { runId }),
    ...(error !== undefined && { error }),
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
  // Past the CI wait the head settles on the run that waited, and the check run that finishes CI triages it again.
  if (settled?.heldForCi && waitsForCi("pending", row.firstSeenAt, now, policy)) return withStatus(row, { status: "waiting", run: settled }, at);
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

function fresh(pr: OpenPr, prior: PrTriageRow | undefined, at: string): PrTriageRow {
  return prior ?? { number: pr.number, headSha: pr.headSha, status: "new", attempts: 0, firstSeenAt: at, updatedAt: at };
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

type Due = { repo: string; index: number; row: PrTriageRow };

/** A head with no run and no verdict, even if its mail failed to deliver. */
function neverTriaged(row: PrTriageRow): boolean {
  return row.status === "new" && row.runId === undefined;
}

/** Never-attempted heads first, then oldest waiting first, a retried head by the time it was last queued; among equals, the oldest pull request first. */
function byWait(a: Due, b: Due): number {
  return Number(neverTriaged(b.row)) - Number(neverTriaged(a.row))
    || ms(a.row.queuedAt ?? a.row.firstSeenAt) - ms(b.row.queuedAt ?? b.row.firstSeenAt)
    || a.row.number - b.row.number;
}

/** Queues a settled head again for `reason`, keeping its attempts since it did not fail. */
export function requeue(plan: RepoPlan, row: PrTriageRow, reason: string, now: Date, policy: ReconcilePolicy): void {
  const index = plan.rows.findIndex((candidate) => candidate.number === row.number && candidate.headSha === row.headSha);
  if (index === -1) return;
  const at = now.toISOString();
  const { runId: _run, error: _error, events: _events, ...rest } = row;
  plan.rows[index] = { ...rest, status: "queued", queuedAt: at, updatedAt: at };
  plan.enqueue.push({ number: row.number, reason, ...(decideNow(row, row.attempts, now, policy) && { noWait: true }) });
}

/** Queues due heads across the tenant's repositories, never-triaged ones first, while fewer than `maxInFlight` heads are queued or running. */
export function planTenant({ repos, runs, now, policy }: TenantPlanInput): Map<string, RepoPlan> {
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
      const current = fresh(pr, byHead.get(key), at);
      const runsOfHead = observed?.get(key) ?? [];
      const seen = uncapped(observe(current, runsOfHead, now, policy), now, policy);
      // A head no webhook queued waits for its running CI like one that did; one with no checks yet is taken as having none.
      const held = seen.status === "new" && ci?.get(key) === "pending" && isDue(seen, pr, runsOfHead, undefined, now, policy) && waitsForCi("pending", seen.firstSeenAt, now, policy);
      const row: PrTriageRow = held ? { ...seen, status: "waiting", updatedAt: at } : seen;
      if (inFlight(row)) busy.add(`${name} ${key}`);
      if (isDue(row, pr, runsOfHead, ci?.get(key), now, policy)) due.push({ repo: name, index: next.length, row });
      next.push(row);
    }
    plans.set(name, { rows: next, enqueue: [] });
  }
  for (const { repo, index, row } of due.sort(byWait).slice(0, Math.max(policy.maxInFlight - busy.size, 0))) {
    const plan = plans.get(repo)!;
    const { runId: _run, error: _error, events, ...rest } = row;
    // The events stay on the row while its run is in flight, so a check run finishing meanwhile is known to be covered by it.
    plan.rows[index] = { ...rest, status: "queued", ...(events !== undefined && { events }), attempts: row.attempts + 1, queuedAt: at, updatedAt: at };
    const reason = row.status === "waiting" ? "waited for CI" : row.error ?? "never triaged";
    const noWait = decideNow(row, row.attempts + 1, now, policy);
    plan.enqueue.push({ number: row.number, reason, ...(events !== undefined && { events }), ...(noWait && { noWait }) });
  }
  return plans;
}
