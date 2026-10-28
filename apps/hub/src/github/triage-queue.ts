// Marks a head queued in the triage state before its mail goes out, so the
// reconciler and repeated requests see it, and puts the row right when that
// mail does not go out. Shared by the manual-run route and the webhook
// coalescer.
import { setTimeout as sleep } from "node:timers/promises";
import { triageStopped, type PrTriageRow, type RepoSource } from "@corbits/triage-contracts";
import { ListenerUnroutedError, TriageStoppedError } from "./deployment.js";
import { BASE_MOVED, type ReconcilePolicy } from "./reconcile-plan.js";
import type { RepoRecord } from "./tenant-config.js";
import { TriageStateConflictError, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

const DELIVERY_FAILED = "delivery failed: ";

/** Why a head's mail did not go out: the next step a person takes when Triage is stopped, else the error. */
export function deliveryFailure(err: unknown): string {
  return err instanceof TriageStoppedError ? err.message : `${DELIVERY_FAILED}${String(err)}`;
}

/** A head marked failed because its mail did not go out, as `deliveryFailure` words it. */
export function undelivered(row: PrTriageRow, source: RepoSource): boolean {
  return row.status === "failed" && row.error !== undefined && (row.error === triageStopped(source) || row.error.startsWith(DELIVERY_FAILED));
}

/** The mail reached no listener: the host had none, or its listener took no mail. A manager that took none is an ordinary failure. */
function reachedNoListener(err: unknown): boolean {
  return err instanceof TriageStoppedError || err instanceof ListenerUnroutedError;
}

/** A pull request mail for the host's listener. */
export type TriageJob = {
  tenantId: string;
  repo: string;
  number: number;
  headSha: string;
  payload: unknown;
  /** The repository a triage job's mail names, which the hub reads the pull request through. */
  record?: RepoRecord;
};

export type QueuedHead = { tenantId: string; repo: string; number: number; headSha: string };

export type Remembered = { prior: PrTriageRow | undefined; rows: PrTriageRow[]; version: TriageStateVersion };

export type QueueOutcome =
  | { status: "queued"; remembered: Remembered }
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
  const { error: _error, unrouted: _unrouted, ...rest } = prior;
  return { ...rest, status: "queued", queuedAt: at, updatedAt: at };
}

function rowOf(rows: readonly PrTriageRow[], { number, headSha }: QueuedHead): PrTriageRow | undefined {
  return rows.find((row) => row.number === number && row.headSha === headSha);
}

function withRow(rows: readonly PrTriageRow[], { number, headSha }: QueuedHead, next: PrTriageRow | undefined): PrTriageRow[] {
  const others = rows.filter((row) => !(row.number === number && row.headSha === headSha));
  return next === undefined ? others : [...others, next];
}

/** Marks the head queued on top of what is stored now unless `keep` holds for its row; a write refused as stale is retried once on a fresh load, `keep` included. */
export async function queueHead(store: TriageStateStore, head: QueuedHead, now: Date, keep: (prior: PrTriageRow | undefined) => boolean): Promise<QueueOutcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await store.load(head.tenantId, head.repo);
    const prior = rowOf(state.rows, head);
    if (keep(prior)) return { status: "kept", prior };
    const rows = withRow(state.rows, head, queuedAgain(prior, head.number, head.headSha, now.toISOString()));
    try {
      const version = await store.save(head.tenantId, head.repo, rows, state.version);
      return { status: "queued", remembered: { prior, rows, version } };
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

/**
 * Marks a still queued head failed after its mail did not go out, so the reconciler queues it again; it keeps when its
 * mail first did not. Mail that reached no run leaves the head unrouted, so it goes out again as soon as a listener is
 * up; true when it did.
 */
export async function failDelivery(store: TriageStateStore, head: QueuedHead, err: unknown, now: Date): Promise<boolean> {
  const unrouted = reachedNoListener(err);
  await replaceQueued(store, head, function failed(row) {
    const at = now.toISOString();
    return { ...row, status: "failed", error: deliveryFailure(err), undeliveredSince: row.undeliveredSince ?? row.queuedAt ?? at, ...(unrouted && { unrouted: true }), updatedAt: at };
  });
  return unrouted;
}

/** Marks a still queued head failed after its mail did not go out, so the reconciler queues it again; it keeps when its mail first did not. */
export function failHead(store: TriageStateStore, head: QueuedHead, error: string, now: Date): Promise<void> {
  return replaceQueued(store, head, function failed(row) {
    const at = now.toISOString();
    return { ...row, status: "failed", error, undeliveredSince: row.undeliveredSince ?? row.queuedAt ?? at, updatedAt: at };
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
      // The base move decides when each head goes out again, one held for a listener included.
      const { unrouted: _unrouted, ...rest } = row;
      if (!staled(row)) return { ...rest, staleBefore: at, updatedAt: at };
      return { ...rest, status: "stale", attempts: 0, error: BASE_MOVED, staleBefore: at, updatedAt: at };
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
