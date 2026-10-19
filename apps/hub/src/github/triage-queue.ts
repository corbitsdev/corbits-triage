// Marks a head queued in the triage state before its mail goes out, so the
// reconciler and repeated requests see it, and puts the row right when that
// mail does not go out. Shared by the manual-run route and the webhook
// coalescer.
import { setTimeout as sleep } from "node:timers/promises";
import type { PrTriageRow, TriageEvent } from "@corbits/triage-contracts";
import { BASE_MOVED, type ReconcilePolicy } from "./reconcile-plan.js";
import { TriageStateConflictError, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export type QueuedHead = { tenantId: string; repo: string; number: number; headSha: string };

export type Remembered = { prior: PrTriageRow | undefined; rows: PrTriageRow[]; version: TriageStateVersion };

export type QueueOutcome =
  | { status: "queued"; remembered: Remembered; held: TriageEvent[] }
  | { status: "kept"; prior: PrTriageRow | undefined }
  | { status: "conflict" };

/** A head the hub queued and has not yet given up waiting on; later the reconciler marks it failed and queues it again itself. */
export function isQueuedSince(row: PrTriageRow | undefined, now: Date, policy: ReconcilePolicy): boolean {
  return row?.status === "queued" && row.queuedAt !== undefined && now.getTime() - new Date(row.queuedAt).getTime() < policy.unstartedAfterMs;
}

/** A head the hub saw running and has not yet given up on as stuck. */
export function isRunningSince(row: PrTriageRow | undefined, now: Date, policy: ReconcilePolicy): boolean {
  return row?.status === "running" && now.getTime() - new Date(row.updatedAt).getTime() <= policy.stuckAfterMs;
}

function queuedAgain(prior: PrTriageRow | undefined, number: number, headSha: string, at: string): PrTriageRow {
  if (prior === undefined) return { number, headSha, status: "queued", attempts: 0, firstSeenAt: at, queuedAt: at, updatedAt: at };
  // The last run and version stay named so the plan can tell this head from one it has never seen.
  const { error: _error, events: _events, ...rest } = prior;
  return { ...rest, status: "queued", queuedAt: at, updatedAt: at };
}

function rowOf(rows: readonly PrTriageRow[], { number, headSha }: QueuedHead): PrTriageRow | undefined {
  return rows.find((row) => row.number === number && row.headSha === headSha);
}

function withRow(rows: readonly PrTriageRow[], { number, headSha }: QueuedHead, next: PrTriageRow | undefined): PrTriageRow[] {
  const others = rows.filter((row) => !(row.number === number && row.headSha === headSha));
  return next === undefined ? others : [...others, next];
}

function replacedBy({ number, headSha }: QueuedHead, row: PrTriageRow): boolean {
  return row.number === number && row.headSha !== headSha && row.status === "waiting";
}

/**
 * Marks the head queued on top of what is stored now unless `keep` holds for its row; a write refused as stale is retried once on a fresh load, `keep` included.
 * With `supersedes`, the same save removes the pull request's rows waiting for CI on heads a new commit replaced, and `held` is the events they held.
 */
export async function queueHead(store: TriageStateStore, head: QueuedHead, now: Date, keep: (prior: PrTriageRow | undefined) => boolean, supersedes: boolean): Promise<QueueOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await store.load(head.tenantId, head.repo);
    const prior = rowOf(state.rows, head);
    if (keep(prior)) return { status: "kept", prior };
    const replaced = supersedes ? state.rows.filter((row) => replacedBy(head, row)) : [];
    const rows = withRow(state.rows.filter((row) => !replaced.includes(row)), head, queuedAgain(prior, head.number, head.headSha, now.toISOString()));
    try {
      const version = await store.save(head.tenantId, head.repo, rows, state.version);
      return { status: "queued", remembered: { prior, rows, version }, held: replaced.flatMap((row) => row.events ?? []) };
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
  }
  return { status: "conflict" };
}

/** Puts back the head's prior row after a mail that did not go out; refused as stale, it is retried once on a fresh load. */
export async function restoreHead(store: TriageStateStore, head: QueuedHead, remembered: Remembered): Promise<void> {
  try {
    await store.save(head.tenantId, head.repo, withRow(remembered.rows, head, remembered.prior), remembered.version);
    return;
  } catch (err) {
    if (!(err instanceof TriageStateConflictError)) throw err;
  }
  const fresh = await store.load(head.tenantId, head.repo);
  await store.save(head.tenantId, head.repo, withRow(fresh.rows, head, remembered.prior), fresh.version);
}

/** Replaces a still queued head's row; refused as stale, it is retried once on a fresh load. */
async function replaceQueued(store: TriageStateStore, head: QueuedHead, next: (row: PrTriageRow) => PrTriageRow): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await store.load(head.tenantId, head.repo);
    const row = rowOf(state.rows, head);
    if (row?.status !== "queued") return;
    try {
      await store.save(head.tenantId, head.repo, withRow(state.rows, head, next(row)), state.version);
      return;
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
  }
  throw new TriageStateConflictError(head.repo);
}

/** Marks a still queued head failed after its mail did not go out, so the reconciler queues it again. */
export function failHead(store: TriageStateStore, head: QueuedHead, error: string, now: Date): Promise<void> {
  return replaceQueued(store, head, function failed(row) {
    return { ...row, status: "failed", error, updatedAt: now.toISOString() };
  });
}

/** Marks a still queued head waiting for its CI instead of mailing it, holding `events` for the run that starts once CI finishes. */
export function waitHead(store: TriageStateStore, head: QueuedHead, events: TriageEvent[], now: Date): Promise<void> {
  return replaceQueued(store, head, function waiting(row) {
    return { ...row, status: "waiting", events, updatedAt: now.toISOString() };
  });
}

/** Saves refused as stale before a base move gives up; each retry loads afresh after a growing pause. */
const BASE_MOVE_ATTEMPTS = 5;
const BASE_MOVE_BACKOFF_MS = 50;

/**
 * Stamps every head of the repository but `except` as outdated by a base
 * branch move: a triaged head, or one failed past its attempts, is stale with
 * its attempts reset, so the reconciler queues it again within its in-flight
 * budget and base move window; a head queued or running is re-run once the
 * run it has ends. Returns how many heads became stale; throws once every save
 * was refused as stale.
 */
export async function markBaseMoved(store: TriageStateStore, tenantId: string, repo: string, except: number | null, now: Date, policy: Pick<ReconcilePolicy, "maxAttempts">): Promise<number> {
  const at = now.toISOString();
  function staled(row: PrTriageRow): boolean {
    return row.number !== except && (row.status === "triaged" || (row.status === "failed" && row.attempts >= policy.maxAttempts));
  }
  for (let attempt = 0; attempt < BASE_MOVE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(BASE_MOVE_BACKOFF_MS * 2 ** (attempt - 1));
    const state = await store.load(tenantId, repo);
    if (state.rows.every((row) => row.number === except)) return 0;
    const rows = state.rows.map(function moved(row): PrTriageRow {
      if (row.number === except) return row;
      if (!staled(row)) return { ...row, staleBefore: at, updatedAt: at };
      return { ...row, status: "stale", attempts: 0, error: BASE_MOVED, staleBefore: at, updatedAt: at };
    });
    try {
      await store.save(tenantId, repo, rows, state.version);
      return state.rows.filter(staled).length;
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
  }
  throw new TriageStateConflictError(repo);
}
