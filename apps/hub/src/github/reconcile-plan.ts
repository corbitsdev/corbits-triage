// Decides, from what GitHub and the run logs say now, which open pull requests
// to queue again. Pure, so every recovery path is decided in one place.
import type { PrTriageRow } from "@corbits/triage-contracts";

export type OpenPr = { number: number; headSha: string; updatedAt: string };

export type ObservedRun = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
};

export type ReconcilePolicy = {
  /** A pull request this recently updated may still have its webhook run on the way. */
  webhookGraceMs: number;
  /** A queued run that has not started by then was lost before it reached the sidecar. */
  unstartedAfterMs: number;
  /** A run still going after this long lost its sidecar. */
  stuckAfterMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Runs the hub queues for one head before it leaves the pull request failed. */
  maxAttempts: number;
};

const MINUTE = 60_000;

export const DEFAULT_RECONCILE_POLICY: ReconcilePolicy = {
  webhookGraceMs: 2 * MINUTE,
  unstartedAfterMs: 10 * MINUTE,
  // Four steps of up to fifteen minutes each, plus their retries.
  stuckAfterMs: 90 * MINUTE,
  backoffBaseMs: 5 * MINUTE,
  backoffMaxMs: 6 * 60 * MINUTE,
  maxAttempts: 5,
};

export type RepoPlanInput = {
  prs: readonly OpenPr[];
  rows: readonly PrTriageRow[];
  /** Every observed run for a head, keyed by `${number}@${headSha}`. */
  runs: ReadonlyMap<string, readonly ObservedRun[]>;
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

/** A completed run settles the head; otherwise the newest run since the hub last queued it speaks. */
function observe(row: PrTriageRow, runs: readonly ObservedRun[], now: Date, policy: ReconcilePolicy): PrTriageRow {
  const at = now.toISOString();
  const completed = runs.find((run) => run.status === "completed");
  if (completed) return withStatus(row, "triaged", completed.runId, undefined, at);
  const since = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt);
  const latest = runs.filter((run) => ms(run.startedAt) >= since).sort((a, b) => ms(b.startedAt) - ms(a.startedAt))[0];
  if (latest === undefined) {
    if (row.status === "queued" && row.queuedAt !== undefined && now.getTime() - ms(row.queuedAt) > policy.unstartedAfterMs) {
      return withStatus(row, "failed", undefined, "run never started", at);
    }
    if (row.status === "running" && now.getTime() - ms(row.updatedAt) > policy.stuckAfterMs) {
      return withStatus(row, "failed", row.runId, "run lost", at);
    }
    return row;
  }
  if (latest.status === "running") {
    if (now.getTime() - ms(latest.startedAt) > policy.stuckAfterMs) return withStatus(row, "failed", latest.runId, "run stuck", at);
    return withStatus(row, "running", latest.runId, undefined, at);
  }
  return withStatus(row, "failed", latest.runId, `run ${latest.status}`, at);
}

function isDue(row: PrTriageRow, pr: OpenPr, now: Date, policy: ReconcilePolicy): boolean {
  if (row.status === "new") return now.getTime() - ms(pr.updatedAt) >= policy.webhookGraceMs;
  if (row.status !== "failed" || row.attempts >= policy.maxAttempts) return false;
  const last = row.queuedAt === undefined ? -Infinity : ms(row.queuedAt);
  return now.getTime() - last >= backoffMs(row.attempts, policy);
}

export function planRepo({ prs, rows, runs, now, policy }: RepoPlanInput): RepoPlan {
  const at = now.toISOString();
  const byHead = new Map(rows.map((row) => [runKey(row.number, row.headSha), row]));
  const next: PrTriageRow[] = [];
  const enqueue: QueuedPr[] = [];
  for (const pr of prs) {
    const key = runKey(pr.number, pr.headSha);
    const prior = byHead.get(key) ?? { number: pr.number, headSha: pr.headSha, status: "new", attempts: 0, firstSeenAt: at, updatedAt: at };
    const row = observe(prior, runs.get(key) ?? [], now, policy);
    if (!isDue(row, pr, now, policy)) {
      next.push(row);
      continue;
    }
    const { runId: _run, error: _error, ...rest } = row;
    next.push({ ...rest, status: "queued", attempts: row.attempts + 1, queuedAt: at, updatedAt: at });
    enqueue.push({ number: pr.number, undelivered: row });
  }
  return { rows: next, enqueue };
}
