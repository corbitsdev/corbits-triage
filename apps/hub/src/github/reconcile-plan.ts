// Decides, from what GitHub and the run logs say now, which open pull requests
// to queue again. Pure, so every recovery path is decided in one place.
import { PR_TRIAGE_STUCK_RUN_MS, type PrTriageRow } from "@corbits/triage-contracts";

export type OpenPr = { number: number; headSha: string; updatedAt: string };

export type ObservedRun = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  /** Why a completed run does not settle the head: no verdict, a degraded one, one made on another commit or with unconfirmed checks. */
  unsettled?: string;
  /** The verdict only waits on GitHub for a machine check, so the head is retried after `unconfirmedRetryMs` rather than at once. */
  unconfirmed?: true;
  /** The workflow version the verdict names; the row remembers it so a later deployment can tell the head needs triage again. */
  verdictVersion?: number;
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
  /** Runs the hub queues for one head before it leaves the pull request failed. */
  maxAttempts: number;
  /** A head capped by runs that never started gets a fresh set of attempts this long after it was capped. */
  cappedRetryAfterMs: number;
  /** Fresh sets of attempts such a head gets before it stays capped. */
  cappedRetryCycles: number;
  /** A verdict waiting only on GitHub, such as mergeability not computed yet, is retried no sooner than this after its run. */
  unconfirmedRetryMs: number;
  /** Heads a tenant has queued or running at once; further due heads wait, never-triaged ones first, then oldest waiting first. */
  maxInFlight: number;
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
  maxInFlight: 5,
};

export type RepoPlanInput = { name: string; prs: readonly OpenPr[]; rows: readonly PrTriageRow[] };

export type TenantPlanInput = {
  repos: readonly RepoPlanInput[];
  /** Every observed run of the deployment, by repository, then by `${number}@${headSha}`, whether or not its repository or head is still here. */
  runs: ReadonlyMap<string, ReadonlyMap<string, readonly ObservedRun[]>>;
  now: Date;
  policy: ReconcilePolicy;
  /** The newest workflow version the live deployment has produced a verdict with; none before its first. */
  workflowVersion: number | undefined;
};

/** A head to queue, why, and the row to keep instead when its mail cannot be delivered. */
export type QueuedPr = { number: number; reason: string; undelivered: PrTriageRow };

/** Rows for exactly the open heads; queued heads are already marked queued. */
export type RepoPlan = { rows: PrTriageRow[]; enqueue: QueuedPr[] };

export function runKey(number: number, headSha: string): string {
  return `${number}@${headSha}`;
}

function ms(iso: string): number {
  return new Date(iso).getTime();
}

export function backoffMs(attempts: number, policy: ReconcilePolicy): number {
  if (attempts === 0) return 0;
  return Math.min(policy.backoffBaseMs * 2 ** (attempts - 1), policy.backoffMaxMs);
}

type Observation = { status: PrTriageRow["status"]; run?: ObservedRun; runId?: string; error?: string };

function withStatus(row: PrTriageRow, { status, run, runId = run?.runId, error }: Observation, now: string): PrTriageRow {
  const workflowVersion = run?.verdictVersion ?? row.workflowVersion;
  if (row.status === status && row.runId === runId && row.error === error && row.workflowVersion === workflowVersion) return row;
  const { runId: _run, error: _error, workflowVersion: _version, ...rest } = row;
  return {
    ...rest,
    status,
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

/**
 * A clean completed run settles the head; otherwise a run still going keeps it
 * running; only once every run has ended does the failure of the one since the
 * hub last queued the head count. A head queued or running on the hub's word
 * only sees runs since it was queued, so a head queued again on top of a
 * verdict stays queued until its new run starts.
 */
function observe(row: PrTriageRow, observed: readonly ObservedRun[], now: Date, policy: ReconcilePolicy): PrTriageRow {
  const at = now.toISOString();
  const runs = row.status === "queued" || row.status === "running" ? sinceQueued(row, observed, policy) : observed;
  const settled = runs.find((run) => run.status === "completed" && run.unsettled === undefined);
  if (settled) return withStatus(row, { status: "triaged", run: settled }, at);
  const live = pick(row, runs.filter((run) => run.status === "running" && !isStuck(run, now, policy)));
  if (live) return withStatus(row, { status: "running", run: live }, at);
  const ended = pick(row, sinceQueued(row, runs, policy));
  if (ended) return withStatus(row, { status: "failed", run: ended, error: failure(ended, isStuck(ended, now, policy)) }, at);
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

function isDue(row: PrTriageRow, pr: OpenPr, runs: readonly ObservedRun[], now: Date, policy: ReconcilePolicy): boolean {
  if (row.status === "new") return now.getTime() - ms(pr.updatedAt) >= policy.webhookGraceMs;
  if (row.status !== "failed" || row.attempts >= policy.maxAttempts) return false;
  const last = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt);
  const verdict = runs.find((run) => run.runId === row.runId);
  const unconfirmedUntil = verdict?.unconfirmed ? ms(verdict.startedAt) + policy.unconfirmedRetryMs : -Infinity;
  return now.getTime() >= Math.max(last + backoffMs(row.attempts, policy), unconfirmedUntil);
}

const STALE_VERDICT = "verdict from workflow version";

/** A head settled or capped under an older workflow version starts over: its verdict may no longer be in the live log and its attempts were spent on old code. */
function fresh(pr: OpenPr, prior: PrTriageRow | undefined, workflowVersion: number | undefined, at: string): PrTriageRow {
  if (prior === undefined) {
    return { number: pr.number, headSha: pr.headSha, status: "new", attempts: 0, ...(workflowVersion !== undefined && { workflowVersion }), firstSeenAt: at, updatedAt: at };
  }
  if (workflowVersion === undefined || (prior.workflowVersion !== undefined && prior.workflowVersion >= workflowVersion)) return prior;
  if (prior.status !== "triaged" && prior.status !== "failed") return prior;
  const { runId: _run, queuedAt: _queued, ...rest } = prior;
  return { ...rest, status: "new", attempts: 0, workflowVersion, error: `${STALE_VERDICT} ${prior.workflowVersion ?? "none"}, current is ${workflowVersion}`, updatedAt: at };
}

/** A queued head counts until the hub marks it failed for never starting, so a backed-up queue is not mailed again. */
export function inFlight(row: PrTriageRow): boolean {
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

/** Queues due heads across the tenant's repositories, never-triaged ones first, while fewer than `maxInFlight` heads are queued or running. */
export function planTenant({ repos, runs, now, policy, workflowVersion }: TenantPlanInput): Map<string, RepoPlan> {
  const at = now.toISOString();
  const plans = new Map<string, RepoPlan>();
  const due: Due[] = [];
  const busy = runningHeads(runs, now, policy);
  for (const { name, prs, rows } of repos) {
    const byHead = new Map(rows.map((row) => [runKey(row.number, row.headSha), row]));
    const observed = runs.get(name);
    const next: PrTriageRow[] = [];
    for (const pr of prs) {
      const key = runKey(pr.number, pr.headSha);
      const runsOfHead = observed?.get(key) ?? [];
      const row = uncapped(observe(fresh(pr, byHead.get(key), workflowVersion, at), runsOfHead, now, policy), now, policy);
      if (inFlight(row)) busy.add(`${name} ${key}`);
      if (isDue(row, pr, runsOfHead, now, policy)) due.push({ repo: name, index: next.length, row });
      next.push(row);
    }
    plans.set(name, { rows: next, enqueue: [] });
  }
  for (const { repo, index, row } of due.sort(byWait).slice(0, Math.max(policy.maxInFlight - busy.size, 0))) {
    const plan = plans.get(repo)!;
    const { runId: _run, error: _error, ...rest } = row;
    plan.rows[index] = { ...rest, status: "queued", attempts: row.attempts + 1, queuedAt: at, updatedAt: at };
    plan.enqueue.push({ number: row.number, reason: row.error ?? "never triaged", undelivered: row });
  }
  return plans;
}
