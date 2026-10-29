import type { SidecarAllocation } from "@intx/db";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type ParkedRunClassifier, type WorkflowRunReader } from "@intx/hub-sessions";

/** Workers a run that never started gets, the first included: a sandbox that never connects mostly comes up on a fresh start. */
export const UNSTARTED_RUN_ATTEMPTS = 3;

export type ReplaceUnstartedRunsOpts = {
  readonly runReader: Pick<WorkflowRunReader, "hasRepository" | "readRunEvents">;
  readonly addressForAnchor: (anchorRunId: string) => Promise<string | null>;
  readonly stock: ParkedRunClassifier;
};

async function nothingCommitted(runReader: ReplaceUnstartedRunsOpts["runReader"], address: string, anchorRunId: string): Promise<boolean> {
  const repoId = workflowRunRepoIdForAddress(address);
  if (!(await runReader.hasRepository(repoId))) return true;
  return (await runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, anchorRunId)).length === 0;
}

/**
 * Stock asks this after a worker misses its connect deadline, and replaces the worker only when it hears `parked`.
 * A run that committed nothing lost nothing with its worker, so it is answered `parked` until it has had
 * `UNSTARTED_RUN_ATTEMPTS` workers; anything else gets stock's answer.
 */
export function replaceUnstartedRuns({ runReader, addressForAnchor, stock }: ReplaceUnstartedRunsOpts) {
  return async function classifyLostWorker(allocation: SidecarAllocation): ReturnType<ParkedRunClassifier> {
    if (allocation.ensureAttempts < UNSTARTED_RUN_ATTEMPTS) {
      const address = await addressForAnchor(allocation.anchorRunId);
      if (address !== null && (await nothingCommitted(runReader, address, allocation.anchorRunId))) {
        return { verdict: "parked", reason: `the run committed nothing, so worker ${String(allocation.ensureAttempts + 1)} starts it` };
      }
    }
    return stock(allocation);
  };
}
