// Copies what the live deployments' run logs say into the verdict table, as the
// tenant observer reads them.
import type { ObservedRuns } from "./triage-runs.js";
import { withApproved, type ApprovedDo, type RecordedVerdict, type VerdictRecordStore } from "./verdict-record-store.js";

export type RunRecorderDeps = {
  verdicts: Pick<VerdictRecordStore, "record" | "recordApproved">;
  log: (entry: Record<string, unknown>) => void;
};

/** False when something could not be recorded; it is recorded again on the next read. */
export type RecordRuns = (tenantId: string, runs: ObservedRuns) => Promise<boolean>;

/** A verdict is recorded once its step completes and again when its run posts the reply or runs its Dos. */
function verdictState(verdict: RecordedVerdict): string {
  return JSON.stringify(verdict);
}

function approvalKey({ repo, number, effectId, status }: ApprovedDo): string {
  return `${repo}#${number}\n${effectId}\n${status}`;
}

/** The verdict with the outcomes of the Dos approved on its head, so recording it, or a re-triage of the head, keeps them. */
function folded(verdict: RecordedVerdict, approved: readonly ApprovedDo[]): RecordedVerdict {
  const own = approved.filter((done) => done.repo === verdict.repo && done.number === verdict.number);
  return verdict.detail && own.length > 0 ? { ...verdict, detail: withApproved(verdict.detail, own) } : verdict;
}

export function createRunRecorder(deps: RunRecorderDeps): RecordRuns {
  /** Verdicts recorded per tenant that its live logs still hold, as recorded; a restart records them again, which changes nothing. */
  const recorded = new Map<string, Set<string>>();

  /** Approved Dos' outcomes recorded per tenant that its live logs still hold. */
  const recordedApproved = new Map<string, Set<string>>();

  return async function recordRuns(tenantId, runs) {
    const seen = recorded.get(tenantId) ?? new Set<string>();
    const seenApproved = recordedApproved.get(tenantId) ?? new Set<string>();
    const verdicts = runs.verdicts.map((verdict) => folded(verdict, runs.approved));
    try {
      await deps.verdicts.record(tenantId, verdicts.filter((verdict) => !seen.has(verdictState(verdict))));
      await deps.verdicts.recordApproved(tenantId, runs.approved.filter((done) => !seenApproved.has(approvalKey(done))));
      recorded.set(tenantId, new Set(verdicts.map(verdictState)));
      recordedApproved.set(tenantId, new Set(runs.approved.map(approvalKey)));
      return true;
    } catch (err) {
      deps.log({ level: "error", msg: "triage_verdicts_unrecorded", tenantId, error: String(err) });
      return false;
    }
  };
}
