/** How many times a finder step is tried before its failure fails the review. */
export const FINDER_ATTEMPTS = 3;

/** The words a finder's error starts its cause with; the failed run's log keeps the rest. */
export const UNREADABLE = "reader: no findings list in the answer";
export const MODEL_FAILED = "reader: inference failed";
export const NO_CHECKOUT = "reader: no checkout";

const FINDERS: Record<string, string> = { findDiff: "diff reviewer", findRepo: "repository reviewer" };

/** Why a review failed, in fixed words for a reader, from the step that failed first and its error. */
export function failureReason(stepId: string, message: string): string {
  if (message.includes(NO_CHECKOUT)) return "The repository checkout wasn't available.";
  if (message.includes(MODEL_FAILED)) return `The model call failed after ${FINDER_ATTEMPTS} tries.`;
  const finder = FINDERS[stepId];
  if (finder && message.includes(UNREADABLE)) return `The ${finder}'s answer couldn't be read.`;
  return "A step of the review failed.";
}
