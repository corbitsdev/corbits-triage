import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf, type KeptVerdict } from "@corbits/triage-contracts";
import { progressMark } from "@corbits/triage-workflows/actions/waiting";
import { writeMark, type MirrorOutcome } from "@corbits/triage-workflows/actions/mirror";
import type { Item } from "@corbits/triage-workflows/logic/item";
import type { Awaits } from "@corbits/triage-workflows/logic/render";
import { managerMailOf } from "./hub.js";
import { Reviewer, TakeOutput, waitingOnHost } from "./manager.js";

const Mailed = { output: { "reviewer?": Reviewer } } as const;
const ProgressInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { items: type("object[]").as<Item[]>() } }, "cleared?": { output: { request: { "header?": type({ verdict: "string", policy: "object | null" }).as<Omit<KeptVerdict, "head">>() } } }, "judgeMailed?": Mailed, "earlyReviewMailed?": Mailed, "reviewMailed?": Mailed });
const Granted = type({ automatic: "string[]", "appLogin?": "string", "codeReview?": "unknown" });
type Parsed = typeof ProgressInput.infer;

/**
 * What the progress leaves in place of itself: on an automatic pass, the pass's verdict where one is posted under the
 * same policy, or while the judge is out, any verdict posted under the pass's policy, until the judge reports. CI
 * running again on the head, or a Review again, shows progress over a verdict.
 */
function keptBy(parsed: Parsed, awaits: readonly Awaits[], again: unknown): Omit<KeptVerdict, "head"> | undefined {
  if (awaits.includes("ci") || again !== undefined) return undefined;
  const header = parsed.cleared?.output.request.header;
  if (header) return { verdict: header.verdict, policy: header.policy };
  // The policy the verdict's header is built from, none when the rules read none.
  if (awaits.includes("judge")) return { policy: parsed.rules.output.items[0]?.source ?? null };
  return undefined;
}

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
  const keepVerdict = keptBy(parsed, awaits, asRecord(granted.codeReview)?.["again"]);
  return writeMark(progressMark(repoSourceOf(pullRequest.source), pull, awaits, granted.appLogin, keepVerdict), ctx);
}
