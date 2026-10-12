// Copies what the live deployments' run logs say into the verdict and Do run
// tables, as the tenant observer reads them.
import type { DoRunStore } from "./do-run-store.js";
import type { ExecutedDo, ObservedRuns } from "./triage-runs.js";
import type { RecordedVerdict, VerdictRecordStore } from "./verdict-record-store.js";

export type RunRecorderDeps = {
  verdicts: Pick<VerdictRecordStore, "record">;
  /** Where the Dos a run executed are recorded, beside those the portal runs. */
  dos: Pick<DoRunStore, "record">;
  log: (entry: Record<string, unknown>) => void;
};

/** False when something could not be recorded; it is recorded again on the next read. */
export type RecordRuns = (tenantId: string, runs: ObservedRuns) => Promise<boolean>;

/** A verdict is recorded once its step completes and again when its run posts the reply or runs its Dos. */
function verdictState(verdict: RecordedVerdict): string {
  return JSON.stringify(verdict);
}

function doKey(executed: ExecutedDo): string {
  return `${executed.runId}\n${executed.effectId}`;
}

export function createRunRecorder(deps: RunRecorderDeps): RecordRuns {
  /** Verdicts recorded per tenant that its live logs still hold, as recorded; a restart records them again, which changes nothing. */
  const recorded = new Map<string, Set<string>>();

  /** Executed Dos recorded per tenant that its live logs still hold; recording one again changes nothing. */
  const recordedDos = new Map<string, Set<string>>();

  return async function recordRuns(tenantId, runs) {
    const seen = recorded.get(tenantId) ?? new Set<string>();
    const seenDos = recordedDos.get(tenantId) ?? new Set<string>();
    try {
      await deps.verdicts.record(tenantId, runs.verdicts.filter((verdict) => !seen.has(verdictState(verdict))));
      for (const { outcome, ...claim } of runs.executed.filter((executed) => !seenDos.has(doKey(executed)))) {
        await deps.dos.record({ ...claim, tenantId, source: "workflow", principalId: null }, outcome);
      }
      recorded.set(tenantId, new Set(runs.verdicts.map(verdictState)));
      recordedDos.set(tenantId, new Set(runs.executed.map(doKey)));
      return true;
    } catch (err) {
      deps.log({ level: "error", msg: "triage_verdicts_unrecorded", tenantId, error: String(err) });
      return false;
    }
  };
}
