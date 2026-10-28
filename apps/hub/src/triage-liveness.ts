// Whether the pull requests a workspace's hub queued still reach a manager. Each reconcile pass reads when a manager
// last took a pull request and the oldest pull request mail recorded since that none has taken; once that mail waited
// past the alarm age, the workspace is stalled until a manager takes again. Alarms live in process: the hub runs as one
// replica, and one restarted on a stalled workspace raises the alarm again on its first pass.
import type { DB } from "@intx/db";
import { lastTakeAt, oldestPendingMail } from "./manager-state.js";

/** A stalled workspace: since when its oldest waiting pull request waits, and when a manager last took one. */
export type Stalled = { since: string; lastTakeAt?: string };

export type TriageLivenessDeps = {
  db: DB["db"];
  /** How long a pull request may wait for a manager before the workspace counts as stalled. */
  stalledAfterMs: number;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createTriageLiveness(deps: TriageLivenessDeps) {
  const alarms = new Map<string, Stalled>();

  async function stalledNow(tenantId: string): Promise<Stalled | undefined> {
    const taken = await lastTakeAt(deps.db, tenantId);
    const since = await oldestPendingMail(deps.db, tenantId, taken);
    if (since === undefined || deps.now().getTime() - Date.parse(since) < deps.stalledAfterMs) return undefined;
    return { since, ...(taken !== undefined && { lastTakeAt: taken }) };
  }

  /** Raises the workspace's alarm once it stalls and clears it once a manager takes again, logging each once. */
  async function watch(tenantId: string): Promise<void> {
    try {
      const stalled = await stalledNow(tenantId);
      const raised = alarms.get(tenantId);
      if (stalled !== undefined) {
        alarms.set(tenantId, stalled);
        if (raised === undefined) deps.log({ level: "error", msg: "triage_stalled", tenantId, ...stalled });
      } else if (raised !== undefined) {
        alarms.delete(tenantId);
        deps.log({ level: "info", msg: "triage_stall_cleared", tenantId, since: raised.since });
      }
    } catch (err) {
      deps.log({ level: "error", msg: "triage_liveness_failed", tenantId, error: String(err) });
    }
  }

  return { watch };
}
