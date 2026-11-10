import type { PreviousReview } from "@corbits/triage-contracts";
import { DIFF_DIR } from "./diff-parts.js";
import { promptText } from "./prompt-text.js";

export const REVIEW_HISTORY = `${DIFF_DIR}/review-history.json`;

export function historyEntries(previous: PreviousReview) {
  return previous.comments.map((prior, index) => ({ index, ...prior, discussion: previous.discussions?.find((thread) => thread.id === prior.thread.id)?.comments }));
}

export function historyContext(previous: PreviousReview): string {
  const text = promptText(JSON.stringify(historyEntries(previous)));
  if (Buffer.byteLength(text) <= 60_000) return text;
  return `The complete history (${previous.comments.length} findings, with their indices and discussions) is in ${REVIEW_HISTORY}. Read it with the repository tools before classifying this finding. If you cannot establish whether it was already addressed within your reading budget, return unsure.`;
}
