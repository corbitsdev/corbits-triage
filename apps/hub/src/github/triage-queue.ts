// Marks a head queued in the triage state before its mail goes out, so the
// reconciler and repeated requests see it, and puts the row right when that
// mail does not go out. Shared by the manual-run route and the webhook
// coalescer.
import type { PrTriageRow } from "@corbits/triage-contracts";
import type { ReconcilePolicy } from "./reconcile-plan.js";
import { TriageStateConflictError, type TriageStateStore, type TriageStateVersion } from "./triage-state-store.js";

export type QueuedHead = { tenantId: string; repo: string; number: number; headSha: string };

/** What the head's row was before it was queued, and the write that queued it. */
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
  const { error: _error, ...rest } = prior;
  return { ...rest, status: "queued", queuedAt: at, updatedAt: at };
}

function rowOf(rows: readonly PrTriageRow[], { number, headSha }: QueuedHead): PrTriageRow | undefined {
  return rows.find((row) => row.number === number && row.headSha === headSha);
}

/** The rows with this head's row replaced, added, or removed when `next` is undefined. */
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
      return { status: "queued", remembered: { prior, rows, version: await store.save(head.tenantId, head.repo, rows, state.version) } };
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

/** Marks a still queued head failed after its mail did not go out, so the reconciler queues it again; refused as stale, it is retried once on a fresh load. */
export async function failHead(store: TriageStateStore, head: QueuedHead, error: string, now: Date): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await store.load(head.tenantId, head.repo);
    const row = rowOf(state.rows, head);
    if (row?.status !== "queued") return;
    try {
      await store.save(head.tenantId, head.repo, withRow(state.rows, head, { ...row, status: "failed", error, updatedAt: now.toISOString() }), state.version);
      return;
    } catch (err) {
      if (!(err instanceof TriageStateConflictError)) throw err;
    }
  }
  throw new TriageStateConflictError(head.repo);
}
