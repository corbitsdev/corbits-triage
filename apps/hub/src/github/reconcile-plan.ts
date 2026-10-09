// Decides, from what GitHub and the run logs say now, which open pull requests
// to queue again. Pure, so every recovery path is decided in one place.
import type { PrTriageRow } from "@corbits/triage-contracts";

export type OpenPr = { number: number; headSha: string; updatedAt: string };

export type ObservedRun = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  /** Why a completed run's verdict is degraded; a degraded verdict does not settle the head. */
  degraded?: string;
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
  /** Heads a tenant has queued or running at once; further due heads wait, oldest waiting first. */
  maxInFlight: number;
};

const MINUTE = 60_000;

export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  webhookGraceMs: 2 * MINUTE,
  unstartedAfterMs: 10 * MINUTE,
  // Four steps of up to fifteen minutes each, plus their retries.
  stuckAfterMs: 90 * MINUTE,
  clockSkewMs: MINUTE,
  backoffBaseMs: 5 * MINUTE,
  backoffMaxMs: 6 * 60 * MINUTE,
  maxAttempts: 5,
  maxInFlight: 5,
};

export type RepoPlanInput = { name: string; prs: readonly OpenPr[]; rows: readonly PrTriageRow[] };

export type TenantPlanInput = {
  repos: readonly RepoPlanInput[];
  /** Every observed run of the deployment, by repository, then by `${number}@${headSha}`, whether or not its repository or head is still here. */
  runs: ReadonlyMap<string, ReadonlyMap<string, readonly ObservedRun[]>>;
  now: Date;
  policy: ReconcilePolicy;
};

/** A head to queue, and the row to keep instead when its mail cannot be delivered. */
export type QueuedPr = { number: number; undelivered: PrTriageRow };

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

function withStatus(row: PrTriageRow, status: PrTriageRow["status"], runId: string | undefined, error: string | undefined, now: string): PrTriageRow {
  if (row.status === status && row.runId === runId && row.error === error) return row;
  const { runId: _run, error: _error, ...rest } = row;
  return {
    ...rest,
    status,
    ...(runId !== undefined && { runId }),
    ...(error !== undefined && { error }),
    updatedAt: now,
  };
}

function failure(run: ObservedRun, stuck: boolean): string {
  if (stuck) return "run stuck";
  return run.degraded ?? `run ${run.status}`;
}

function isStuck(run: ObservedRun, now: Date, policy: ReconcilePolicy): boolean {
  return run.status === "running" && now.getTime() - ms(run.startedAt) > policy.stuckAfterMs;
}

/** The run the row already names wins; otherwise the newest. */
function pick(row: PrTriageRow, runs: readonly ObservedRun[]): ObservedRun | undefined {
  return runs.find((run) => run.runId === row.runId) ?? [...runs].sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
}

/**
 * A clean completed run settles the head; otherwise a run still going keeps it
 * running; only once every run has ended does the failure of the one since the
 * hub last queued the head count.
 */
function observe(row: PrTriageRow, runs: readonly ObservedRun[], now: Date, policy: ReconcilePolicy): PrTriageRow {
  const at = now.toISOString();
  const settled = runs.find((run) => run.status === "completed" && run.degraded === undefined);
  if (settled) return withStatus(row, "triaged", settled.runId, undefined, at);
  const live = pick(row, runs.filter((run) => run.status === "running" && !isStuck(run, now, policy)));
  if (live) return withStatus(row, "running", live.runId, undefined, at);
  const since = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt) - policy.clockSkewMs;
  const ended = pick(row, runs.filter((run) => ms(run.startedAt) >= since));
  if (ended) return withStatus(row, "failed", ended.runId, failure(ended, isStuck(ended, now, policy)), at);
  if (row.status === "queued" && row.queuedAt !== undefined && now.getTime() - ms(row.queuedAt) > policy.unstartedAfterMs) {
    return withStatus(row, "failed", undefined, "run never started", at);
  }
  if (row.status === "running" && now.getTime() - ms(row.updatedAt) > policy.stuckAfterMs) {
    return withStatus(row, "failed", row.runId, "run lost", at);
  }
  return row;
}

function isDue(row: PrTriageRow, pr: OpenPr, now: Date, policy: ReconcilePolicy): boolean {
  if (row.status === "new") return now.getTime() - ms(pr.updatedAt) >= policy.webhookGraceMs;
  if (row.status !== "failed" || row.attempts >= policy.maxAttempts) return false;
  const last = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt);
  return now.getTime() - last >= backoffMs(row.attempts, policy);
}

/** A queued head counts until the hub marks it failed for never starting, so a backed-up queue is not mailed again. */
function inFlight(row: PrTriageRow): boolean {
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

/** Oldest waiting first, a retried head by the time it was last queued; among equals, the oldest pull request first. */
function byWait(a: Due, b: Due): number {
  return ms(a.row.queuedAt ?? a.row.firstSeenAt) - ms(b.row.queuedAt ?? b.row.firstSeenAt) || a.row.number - b.row.number;
}

/** Queues due heads across the tenant's repositories while fewer than `maxInFlight` heads are queued or running. */
export function planTenant({ repos, runs, now, policy }: TenantPlanInput): Map<string, RepoPlan> {
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
      const prior = byHead.get(key) ?? { number: pr.number, headSha: pr.headSha, status: "new", attempts: 0, firstSeenAt: at, updatedAt: at };
      const row = observe(prior, observed?.get(key) ?? [], now, policy);
      if (inFlight(row)) busy.add(`${name} ${key}`);
      if (isDue(row, pr, now, policy)) due.push({ repo: name, index: next.length, row });
      next.push(row);
    }
    plans.set(name, { rows: next, enqueue: [] });
  }
  for (const { repo, index, row } of due.sort(byWait).slice(0, Math.max(policy.maxInFlight - busy.size, 0))) {
    const plan = plans.get(repo)!;
    const { runId: _run, error: _error, ...rest } = row;
    plan.rows[index] = { ...rest, status: "queued", attempts: row.attempts + 1, queuedAt: at, updatedAt: at };
    plan.enqueue.push({ number: row.number, undelivered: row });
  }
  return plans;
}
