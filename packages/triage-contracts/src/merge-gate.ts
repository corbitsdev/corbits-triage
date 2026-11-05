/** What CI says of a pull request's head, summed over its check runs. */
export type HeadCi = "success" | "failure" | "pending" | "cancelled" | "none";

const CI_TEXT: Record<HeadCi, string> = {
  success: "CI passed on this head",
  failure: "CI has failed on this head",
  pending: "CI has not finished on this head",
  cancelled: "CI was cancelled on this head",
  none: "There is no CI on this head",
};

export function ciRefusal(ci: HeadCi): string {
  return CI_TEXT[ci];
}

/**
 * What a merge is decided on. `changesRequestedBy` is each reviewer, other than Triage, whose latest review requests
 * changes; `threadsHold` is why the review threads hold the merge, or undefined when they do not.
 */
export type MergeInput = { ci: HeadCi; ciOptional: boolean; changesRequestedBy: readonly string[]; threadsHold: string | undefined };

/** A person's review or thread waits on that person; CI waits on the head's checks. */
export type MergeRefusal = { allowed: false; cause: "changes-requested" | "threads"; reason: string } | { allowed: false; cause: "ci"; ci: Exclude<HeadCi, "success">; reason: string };

/**
 * Whether a pull request may merge: no reviewer requests changes, no review thread holds it, and its CI passed, or it
 * has none and the policy does not require it. People are asked first, so CI never stands in for their answer.
 */
export function mergeGate({ ci, ciOptional, changesRequestedBy, threadsHold }: MergeInput): { allowed: true } | MergeRefusal {
  if (changesRequestedBy.length > 0) return { allowed: false, cause: "changes-requested", reason: `changes are requested by ${changesRequestedBy.join(", ")}` };
  if (threadsHold !== undefined) return { allowed: false, cause: "threads", reason: threadsHold };
  if (ci === "success" || (ci === "none" && ciOptional)) return { allowed: true };
  return { allowed: false, cause: "ci", ci, reason: ciRefusal(ci) };
}
