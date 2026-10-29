import { type } from "arktype";
import { blockCleanSchema, CodeReviewOutput, RULE_GATES, rulesGate, SEVERITIES, VERDICTS, type ActionKind } from "@corbits/triage-contracts";
import { verdictWithFailure } from "@corbits/triage-workflows/actions/evaluate";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { awaitsText, type Verdict } from "@corbits/triage-workflows/logic/render";
import { LIFETIME_MS, storedReview, TakeOutput } from "./manager.js";

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES), "clean?": blockCleanSchema });
const TakenPart = type({ codeReview: CodeReviewPart });

/** Both say the pull request may land, so neither runs unattended past a code review that is not clean. */
const HELD_KINDS: readonly ActionKind[] = ["approve", "merge"];

const Scope = type({ reviewed: "boolean", "skipped?": "string" });
type Scope = typeof Scope.infer;

type Finding = CodeReviewOutput["comments"][number];

/** Where a finding's priority, 0 the most severe, sits in `SEVERITIES`; a finding without one counts as the most severe. */
function severityAt({ priority = 0 }: Finding): number {
  return Math.min(Math.max(SEVERITIES.length - 1 - priority, 0), SEVERITIES.length - 1);
}

type Unclean = { held: string } | { found: number };

/** Why the review is not clean: none reported, or it did not read the whole change; or how many findings are at or above `below`. */
function uncleanBy(review: CodeReviewOutput | undefined, below: (typeof SEVERITIES)[number] | undefined): Unclean | undefined {
  if (!review) return { held: "Code review did not report on this head." };
  if (review.budgetExhausted || review.complete !== true) return { held: "Code review did not read the whole change on this head." };
  const floor = below === undefined ? 0 : SEVERITIES.indexOf(below);
  const found = review.comments.filter((finding) => severityAt(finding) >= floor).length;
  return found > 0 ? { found } : undefined;
}

/** A Do already held keeps its own reason, such as waiting for CI. */
function hold<A extends object>(action: A, reason: string): A {
  const { effectId, kind, held } = action as { effectId?: unknown; kind?: unknown; held?: unknown };
  if (typeof effectId !== "string" || held === true || !HELD_KINDS.some((each) => each === kind)) return action;
  return { ...action, held: true, reason };
}

/**
 * Why the pass's verdict is not cleared while the policy turns code review on. Code review must have run on the head and
 * be clean as its block's `clean` says; one the policy's `for` or `when` left out counts as off, and one held back by
 * failed or unsettled rules did not run. A review that failed or ran past its deadline reported nothing.
 */
function uncleared({ taken, review, reviewers, head }: TakeOutput, checks: unknown, scope: Scope): Unclean | undefined {
  const part = TakenPart(taken);
  if (part instanceof type.errors) return undefined;
  const { codeReview } = part;
  const leftOut = scope.skipped !== undefined && rulesGate(codeReview.rules, checks).open;
  const reviewing = codeReview.on && !leftOut;
  if (!reviewing) return undefined;
  if (!scope.reviewed) return { held: "Code review did not run on this head." };
  const reported = review ?? (head === undefined ? undefined : storedReview(reviewers, head));
  return uncleanBy(reported, codeReview.clean?.below);
}

/** The verdict fields cleared reads, the rest kept as evaluate made them. */
export const ClearedVerdict = type({
  number: "number", headSha: "string | null", verdict: type.enumerated(...VERDICTS), reason: "string", reasons: "string[]", feedback: "string", checks: "object[]", actions: "object[]",
  degraded: "string | null", "approvable?": "boolean", "closed?": "true",
}).as<Verdict>();

const ClearedInput = type({
  take: { output: TakeOutput },
  rules: { output: { items: type("object[]").as<Item[]>() } },
  evaluateRules: { output: ClearedVerdict },
  reviewScope: { output: Scope },
});

/** A code review with findings on the head is a failed check of its own. */
function reviewFailure(found: number): CheckResult {
  const reason = `Code review found ${found} ${found === 1 ? "problem" : "problems"} on this head.`;
  return { check: "code-review", kind: "machine", result: "fail", reason, evidence: [], output: { kind: "values", values: { findings: found } } };
}

/**
 * The verdict `found`, the review's problems, leave: evaluate's with the review among its checks and reasons, a Pass
 * turned to Fail with the policy's fail Dos, rebuilt from the rules item it was made from: the one at its head, or its
 * pull request's alone for a degraded verdict that names no head. One that cannot be made, or with no such item, such
 * as a judge's verdict on a head the rules read past, leaves the verdict as the rules made it.
 */
function reviewed(items: Item[], verdict: Verdict, found: number): Verdict {
  const item = items.find(({ facts }) => facts.number === verdict.number && (verdict.headSha === null || facts.headSha === verdict.headSha));
  if (!item) return verdict;
  try {
    return verdictWithFailure(item, verdict, reviewFailure(found));
  } catch {
    // An action has no logger; the verdict's approve and merge are still held for the review's problems.
    return verdict;
  }
}

/** `verdict` with its approve and merge Dos held for a person, saying why, and not approvable. */
function held(verdict: Verdict, reason: string): Verdict {
  return { ...verdict, actions: verdict.actions.map((action) => hold(action, reason)), ...(verdict.approvable !== undefined && { approvable: false }) };
}

/**
 * The pass's verdict once the policy's checks are in. A verdict whose code review found problems on its head names
 * them, waiting, degraded or decided, and a Pass among them fails with the policy's fail Dos. A closed pull request has
 * no verdict to name them in, a take that names no head has no review of one, and a verdict on another head was not
 * reviewed, so each is only held. While a check is not clean, approve and merge are held for a person, saying why, and
 * the head is not approvable, so an approval Triage gave an earlier head is taken back.
 */
export async function cleared(input: unknown): Promise<Verdict> {
  const parsed = ClearedInput(input);
  if (parsed instanceof type.errors) throw new Error(`cleared: ${parsed.summary}`);
  const { stopped } = parsed.take.output;
  const verdict = clean(parsed);
  return stopped ? stoppedWaiting(verdict, stopped) : verdict;
}

/**
 * A verdict made once the manager's lifetime ran out: it says what Triage stopped waiting for, and every Do is held for
 * a person, since it was decided without them.
 */
function stoppedWaiting(verdict: Verdict, stopped: NonNullable<TakeOutput["stopped"]>): Verdict {
  const note = `Triage stopped waiting for ${awaitsText(stopped)} after ${LIFETIME_MS / (60 * 60_000)} hours, so no action ran on its own.`;
  const actions = verdict.actions.map(function heldForAPerson(action) {
    if (!("effectId" in action)) return action;
    // Held for a person, so no CI state alone holds it any longer.
    const { ci: _ci, ...held } = action;
    return { ...held, held: true as const, reason: note };
  });
  const feedback = verdict.feedback ? `${verdict.feedback}\n\n${note}` : note;
  const request = verdict.request && { ...verdict.request, comment: verdict.request.comment ? `${verdict.request.comment}\n\n${note}` : note };
  return { ...verdict, actions, feedback, reasons: [...verdict.reasons, note], ...(request && { request }), ...(verdict.approvable !== undefined && { approvable: false }) };
}

function clean(parsed: typeof ClearedInput.infer): Verdict {
  const verdict = parsed.evaluateRules.output;
  const { head } = parsed.take.output;
  const unclean = uncleared(parsed.take.output, verdict.checks, parsed.reviewScope.output);
  if (unclean === undefined) return verdict;
  if (!("found" in unclean)) return held(verdict, unclean.held);
  const reason = reviewFailure(unclean.found).reason;
  if (verdict.closed || head === undefined || (verdict.headSha !== null && verdict.headSha !== head)) return held(verdict, reason);
  return held(reviewed(parsed.rules.output.items, verdict, unclean.found), reason);
}
