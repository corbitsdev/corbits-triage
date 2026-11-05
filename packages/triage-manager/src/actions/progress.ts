import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf, type Awaits, type KeptVerdict } from "@corbits/triage-contracts";
import { withoutDos } from "@corbits/triage-workflows/actions/evaluate";
import { waitingMark } from "@corbits/triage-workflows/actions/waiting";
import { writeMark, type MirrorOutcome } from "@corbits/triage-workflows/actions/mirror";
import { CODE_REVIEW_RUNNING, type Verdict } from "@corbits/triage-workflows/logic/render";
import { managerMailOf } from "./hub.js";
import { verdict } from "./judge.js";
import { Reviewer, TakeOutput, waitingOnHost } from "./manager.js";

const Mailed = { output: { "reviewer?": Reviewer } } as const;
/** A verdict's comment header, which names the verdict and policy it was made under. */
const Headed = type({ request: { "header?": type({ verdict: "string", policy: "object | null" }).as<Omit<KeptVerdict, "head">>() } });
const ProgressInput = type({ payload: "unknown", take: { output: TakeOutput }, rules: { output: { items: "object[]" } }, "cleared?": { output: Headed }, "evaluateRules?": { output: type({ feedback: "string", actions: "object[]" }).as<Pick<Verdict, "feedback" | "actions">>() }, "judgeMailed?": Mailed, "earlyReviewMailed?": Mailed, "reviewMailed?": Mailed });
const Granted = type({ automatic: "string[]", "appLogin?": "string", "codeReview?": "unknown" });
type Parsed = typeof ProgressInput.infer;

/**
 * What the progress leaves in place of itself on an automatic pass: the verdict this pass's rules give, under its policy,
 * where that is already posted on the head. While the judge is out, that is the verdict `verdict` would post were the
 * judge to fail, made from the rules alone. CI running again on the head, or a Review again, shows progress.
 */
async function keptBy(input: unknown, parsed: Parsed, awaits: readonly Awaits[], again: unknown, ctx: EffectContext, signal: AbortSignal): Promise<Omit<KeptVerdict, "head"> | undefined> {
  if (awaits.includes("ci") || again !== undefined) return undefined;
  const cleared = parsed.cleared?.output.request.header;
  if (cleared) return { verdict: cleared.verdict, policy: cleared.policy };
  if (!awaits.includes("judge")) return undefined;
  const machine = Headed(await verdict(input, ctx, signal));
  if (machine instanceof type.errors) throw new Error(`progress: ${machine.summary}`);
  const header = machine.request.header;
  return header && { verdict: header.verdict, policy: header.policy };
}

/**
 * What the in-progress comment shows once the decision model answered and only code review is out: the verdict's comment
 * under its title, without the Dos, which wait for code review too.
 */
function knownOf(parsed: Parsed, awaits: readonly Awaits[]): string | undefined {
  const rules = parsed.evaluateRules?.output;
  if (rules === undefined || !awaits.includes("code-review") || awaits.includes("judge")) return undefined;
  const results = withoutDos(rules.feedback, rules.actions).split("\n\n").slice(1).join("\n\n").trimEnd();
  return [results, CODE_REVIEW_RUNNING].filter(Boolean).join("\n\n");
}

/**
 * Shows the waiting marker while the pass's head waits for its judge or code review, naming what it waits for, CI among
 * it while that still runs: its labels where triage labels, its in-progress comment where triage comments, showing the
 * verdict's results while only code review is out. The verdict replaces both. The host leaves a comment that already
 * says this as it is.
 */
export async function progress(input: unknown, ctx: EffectContext, signal: AbortSignal): Promise<MirrorOutcome | { skipped: true }> {
  const parsed = ProgressInput(input);
  if (parsed instanceof type.errors) throw new Error(`progress: ${parsed.summary}`);
  const { head, taken, reviewers, judge, judgeFailed, review, reviewFailed } = parsed.take.output;
  const granted = Granted(taken);
  if (head === undefined || granted instanceof type.errors) return { skipped: true };
  const mailed = [parsed.judgeMailed, parsed.earlyReviewMailed, parsed.reviewMailed].flatMap((step) => (step?.output.reviewer ? [step.output.reviewer] : []));
  const out = [...reviewers, ...mailed].filter((reviewer) => reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) > Date.now());
  const reported = { judge: judge !== undefined || judgeFailed !== undefined, "code-review": review !== undefined || reviewFailed !== undefined };
  const reviewing = (["judge", "code-review"] as const).filter((kind) => !reported[kind] && out.some((reviewer) => reviewer.kind === kind));
  const awaits: Awaits[] = [...(waitingOnHost(parsed.rules.output.items) ? ["ci" as const] : []), ...reviewing];
  if (awaits.length === 0) return { skipped: true };
  const { pullRequest } = managerMailOf(parsed.payload);
  const facts = { repo: pullRequest.repo, number: pullRequest.number, headSha: head };
  const keepVerdict = await keptBy(input, parsed, awaits, asRecord(granted.codeReview)?.["again"], ctx, signal);
  const mark = waitingMark(repoSourceOf(pullRequest.source), facts, awaits, granted.automatic, granted.appLogin, keepVerdict, knownOf(parsed, awaits));
  return mark ? writeMark(mark, ctx) : { skipped: true };
}
