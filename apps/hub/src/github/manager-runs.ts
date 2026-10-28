// Pull requests' managers as the reconciler reads a deployment's runs, from their claims and the verdicts they
// reported: a manager that is up runs the newest head the hub recorded a mail for, one that went away mid-pass failed
// on its pass's head, a head its last pass held for CI waits for it, and each verdict a manager recorded settles its
// head as a pr-triage run's does.
import type { DB } from "@intx/db";
import { unsettledBy } from "@corbits/triage-workflows/logic/settled";
import { managedPulls, type PullRequestRef } from "../manager-state.js";
import { runKey, type ObservedRun } from "./reconcile-plan.js";
import type { VerdictRecord, VerdictRecordStore } from "./verdict-record-store.js";

/** Runs by repository, then by `${number}@${headSha}`. */
export type ObservedRuns = { byRepo: Map<string, Map<string, ObservedRun[]>> };

/** The runs of `pulls`' managers. */
export type ManagerRuns = (tenantId: string, pulls: readonly PullRequestRef[]) => Promise<ObservedRuns>;

function settlesBy(verdict: VerdictRecord): Pick<ObservedRun, "unsettled" | "unconfirmed"> {
  const { detail } = verdict;
  return unsettledBy({ degraded: verdict.degraded, reason: detail?.reason, headSha: detail?.headSha, state: verdict.state, checks: detail?.checks }, verdict.headSha);
}

export function createManagerRuns(db: DB["db"], verdicts: Pick<VerdictRecordStore, "ofRuns">, now: () => Date): ManagerRuns {
  return async function managerRuns(tenantId, asked) {
    const pulls = await managedPulls(db, tenantId, asked);
    const recorded = await verdicts.ofRuns(tenantId, [...new Set(pulls.flatMap((pull) => pull.history.map((pass) => pass.runId)))], asked);
    const byRepo: ObservedRuns["byRepo"] = new Map();

    function observed(repo: string, number: number, head: string, run: ObservedRun): void {
      const byHead = byRepo.get(repo) ?? new Map<string, ObservedRun[]>();
      byRepo.set(repo, byHead);
      const key = runKey(number, head);
      const listed = byHead.get(key);
      if (listed) listed.push(run);
      else byHead.set(key, [run]);
    }

    for (const { pr, history, live, gone } of pulls) {
      const { source } = pr;
      // The hub checked the run is up, so it is running now and never stuck.
      if (live?.head !== undefined) observed(pr.repo, pr.number, live.head, { runId: live.runId, source, status: "running", startedAt: now().toISOString(), ...(live.pass && { passAt: live.pass.takenAt }), ...(live.awaiting.length > 0 && { awaiting: live.awaiting }) });
      if (gone) observed(pr.repo, pr.number, gone.pass.head, { runId: gone.runId, source, status: "failed", startedAt: gone.pass.takenAt });
      // A head's last pass decides whether it still waits for CI; a waiting run is listed first so it outranks an older verdict.
      const lastOfHead = new Map(history.map((pass) => [pass.head, pass]));
      for (const pass of lastOfHead.values()) {
        if (pass.waiting) observed(pr.repo, pr.number, pass.head, { runId: pass.runId, source, status: "completed", startedAt: pass.takenAt, heldForCi: true });
      }
      for (const verdict of recorded.filter((row) => row.repo === pr.repo && row.number === pr.number)) {
        observed(pr.repo, pr.number, verdict.headSha, { runId: verdict.runId, source, status: "completed", startedAt: verdict.startedAt.toISOString(), ...settlesBy(verdict), ...(verdict.trigger !== null && { trigger: verdict.trigger }) });
      }
    }
    return { byRepo };
  };
}
