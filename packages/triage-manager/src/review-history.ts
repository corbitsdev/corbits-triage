import { type } from "arktype";
import { CodeReviewOutput, type PreviousReview } from "@corbits/triage-contracts";
import type { TakeOutput } from "./actions/manager.js";

/** Thread identity survives edits, a quiet review, and resolution; later rounds refresh descriptions and host state. */
export function previousReviewOf(take: TakeOutput, excluding?: string): PreviousReview | undefined {
  const reviewers = take.reviewers.filter((reviewer) => reviewer.kind === "code-review" && reviewer.runId !== excluding).toSorted((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline));
  const comments = new Map<number, PreviousReview["comments"][number]>();
  let head: string | undefined;
  for (const reviewer of reviewers) {
    const review = CodeReviewOutput(reviewer.result);
    if (review instanceof type.errors) continue;
    head = reviewer.head;
    const posted = take.commentThreads?.find((row) => row.runId === reviewer.runId);
    for (const [index, finding] of review.comments.entries()) {
      const thread = posted?.threads.length === review.comments.length ? posted.threads[index] : finding.thread;
      if (thread) comments.set(thread.id, { ...finding, thread });
    }
  }
  return head === undefined || comments.size === 0 ? undefined : { head, comments: [...comments.values()] };
}
