import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf, VERDICTS } from "@corbits/triage-contracts";
import { progressMark } from "@corbits/triage-workflows/actions/waiting";
import { writeMark, type MirrorOutcome } from "@corbits/triage-workflows/actions/mirror";
import type { Awaits } from "@corbits/triage-workflows/logic/render";
import { managerMailOf } from "./hub.js";
import { Reviewer, TakeOutput, waitingOnHost } from "./manager.js";

const Mailed = { output: { "reviewer?": Reviewer } } as const;
const ProgressInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { items: "object[]" } }, "cleared?": { output: { verdict: type.enumerated(...VERDICTS) } }, "judgeMailed?": Mailed, "earlyReviewMailed?": Mailed, "reviewMailed?": Mailed });
const Granted = type({ automatic: "string[]", "appLogin?": "string", "codeReview?": "unknown" });

/**
 * Shows the in-progress comment while the pass's head waits for its judge or code review, naming what it waits for,
 * CI among it while that still runs, where triage comments; the verdict replaces it in place. The host leaves a comment
 * that already says this as it is.
 */
export async function progress(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<MirrorOutcome | { skipped: true }> {
  const parsed = ProgressInput(input);
  if (parsed instanceof type.errors) throw new Error(`progress: ${parsed.summary}`);
  const { head, taken, reviewers, judge, judgeFailed, review, reviewFailed } = parsed.take.output;
  const granted = Granted(taken);
  if (head === undefined || granted instanceof type.errors || !granted.automatic.includes("comment")) return { skipped: true };
  const mailed = [parsed.judgeMailed, parsed.earlyReviewMailed, parsed.reviewMailed].flatMap((step) => (step?.output.reviewer ? [step.output.reviewer] : []));
  const out = [...reviewers, ...mailed].filter((reviewer) => reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) > Date.now());
  const reported = { judge: judge !== undefined || judgeFailed !== undefined, "code-review": review !== undefined || reviewFailed !== undefined };
  const reviewing = (["judge", "code-review"] as const).filter((kind) => !reported[kind] && out.some((reviewer) => reviewer.kind === kind));
  const awaits: Awaits[] = [...(waitingOnHost(parsed.rules.output.items) ? ["ci" as const] : []), ...reviewing];
  if (awaits.length === 0) return { skipped: true };
  const { pullRequest } = managerMailOf(parsed.payload);
  const pull = { repo: pullRequest.repo, number: pullRequest.number, onHead: head };
  // Only CI running again on the head, or a Review again, shows progress over the pass's verdict already posted on it.
  const keepVerdict = !awaits.includes("ci") && asRecord(granted.codeReview)?.["again"] === undefined ? parsed.cleared?.output.verdict : undefined;
  return writeMark(progressMark(repoSourceOf(pullRequest.source), pull, awaits, granted.appLogin, keepVerdict), ctx);
}
