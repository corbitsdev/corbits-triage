import type { SidecarAllocation } from "@intx/db";
import type { ParkedRunClassifier } from "@intx/hub-sessions";

/** Workers a run that never deployed gets in all: a sandbox that never connects mostly comes up on a fresh start. */
export const UNSTARTED_RUN_ATTEMPTS = 3;

type ReplaceUnstartedRunsOpts = {
  /** The anchor run's public key, which stock records only once a generation finished deploying it. */
  readonly publicKeyForAnchor: (anchorRunId: string) => Promise<string | null>;
  readonly stock: ParkedRunClassifier;
};

/**
 * Stock asks this after a worker misses its connect deadline, and replaces the worker only when it hears `parked`.
 * A run whose deploy never finished ran nothing on its worker, so it is answered `parked` until it has had
 * `UNSTARTED_RUN_ATTEMPTS` workers; anything else gets stock's answer.
 */
export function replaceUnstartedRuns({ publicKeyForAnchor, stock }: ReplaceUnstartedRunsOpts) {
  return async function classifyLostWorker(allocation: SidecarAllocation): ReturnType<ParkedRunClassifier> {
    if (allocation.ensureAttempts < UNSTARTED_RUN_ATTEMPTS && (await publicKeyForAnchor(allocation.anchorRunId)) === null) {
      return { verdict: "parked", reason: `the run never finished deploying, so worker ${String(allocation.ensureAttempts + 1)} deploys it` };
    }
    return stock(allocation);
  };
}
