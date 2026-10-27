import { type } from "arktype";
import { BLOCK_KINDS, blockCleanSchema, CodeReviewOutput, RULE_GATES, rulesGate, SEVERITIES, VERDICTS, type ActionKind } from "@corbits/triage-contracts";
import { verdictWithFailure } from "@corbits/triage-workflows/actions/evaluate";
import type { CheckResult } from "@corbits/triage-workflows/logic/checks";
import type { Item } from "@corbits/triage-workflows/logic/item";
import type { Verdict } from "@corbits/triage-workflows/logic/render";
import { storedReview, TakeOutput } from "./manager.js";

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES), "clean?": blockCleanSchema });
const BlocksPart = type({ blocks: type.enumerated(...BLOCK_KINDS).array(), codeReview: CodeReviewPart });

/** Both say the pull request may land, so neither runs unattended past a code review that is not clean. */
const HELD_KINDS: readonly ActionKind[] = ["approve", "merge"];

const Scope = type({ reviewed: "boolean", "skipped?": "string" });
type Scope = typeof Scope.infer;

type Finding = CodeReviewOutput["comments"][number];

/** Where a finding's priority, 0 the most severe, sits in `SEVERITIES`; a finding without one counts as the most severe. */
function severityAt({ priority = 0 }: Finding): number {
  return Math.min(Math.max(SEVERITIES.length - 1 - priority, 0), SEVERITIES.length - 1);
}

/** Why the review is not clean: none reported, or it read only part of the change; or how many findings are at or above `below`. */
type Unclean = { held: string } | { found: number };

function uncleanBy(review: CodeReviewOutput | undefined, below: (typeof SEVERITIES)[number] | undefined): Unclean | undefined {
  if (!review) return { held: "Code review did not report on this head." };
  if (review.budgetExhausted || review.cut) return { held: "Code review did not read the whole change on this head." };
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
 * Why the pass's verdict is not cleared while the policy turns a check on. Problems code review found on the head come
 * first, so another check that can't run yet never hides them; such a check holds approve and merge until it can.
 * Code review must have run on the head and be clean as its block's `clean` says; one the policy's `for` or `when` left
 * out counts as off, and one held back by failed or unsettled rules did not run. A review that failed or ran past its
 * deadline reported nothing.
 */
function uncleared({ taken, review, reviewers, head }: TakeOutput, checks: unknown, scope: Scope): Unclean | undefined {
  const part = BlocksPart(taken);
  if (part instanceof type.errors) return undefined;
  const { blocks, codeReview } = part;
  const waiting = blocks.filter((kind) => kind !== "code-review");
  const leftOut = scope.skipped !== undefined && rulesGate(codeReview.rules, checks).open;
  const reviewing = codeReview.on && !leftOut;
  const reported = review ?? (head === undefined ? undefined : storedReview(reviewers, head));
  const unclean = reviewing && scope.reviewed ? uncleanBy(reported, codeReview.clean?.below) : undefined;
  if (unclean && "found" in unclean) return unclean;
  if (waiting.length > 0) return { held: `The policy's ${waiting.join(" and ")} check can't run yet.` };
  if (!reviewing) return undefined;
  if (!scope.reviewed) return { held: "Code review did not run on this head." };
  return unclean;
}

/** The verdict fields cleared reads, the rest kept as evaluate made them. */
const ClearedVerdict = type({
  number: "number", verdict: type.enumerated(...VERDICTS), reason: "string", reasons: "string[]", feedback: "string", checks: "object[]", actions: "object[]",
  "approvable?": "boolean", "closed?": "true",
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
 * The verdict `found`, the review's problems on `head`, leave: evaluate's with the review among its checks and reasons,
 * a Pass turned to Fail with the policy's fail Dos, rebuilt from the rules item of the verdict's pull request at `head`.
 * One that cannot be made leaves the verdict as the rules made it.
 */
function reviewed(items: Item[], verdict: Verdict, head: string, found: number): Verdict {
  const item = items.find(({ facts }) => facts.number === verdict.number && facts.headSha === head);
  if (!item) throw new Error(`cleared: the rules output has no item for #${verdict.number} at ${head}`);
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
 * them, waiting, degraded or decided, and a Pass among them fails with the policy's fail Dos; a closed pull request has
 * no verdict to name them in, and a take that names no head has no review of one. While a check is not clean, approve
 * and merge are held for a person, saying why, and the head is not approvable, so an approval Triage gave an earlier
 * head is taken back.
 */
export async function cleared(input: unknown): Promise<Verdict> {
  const parsed = ClearedInput(input);
  if (parsed instanceof type.errors) throw new Error(`cleared: ${parsed.summary}`);
  const verdict = parsed.evaluateRules.output;
  const { head } = parsed.take.output;
  const unclean = uncleared(parsed.take.output, verdict.checks, parsed.reviewScope.output);
  if (unclean === undefined) return verdict;
  if (!("found" in unclean)) return held(verdict, unclean.held);
  if (head === undefined) return verdict;
  const reason = reviewFailure(unclean.found).reason;
  if (verdict.closed) return held(verdict, reason);
  return held(reviewed(parsed.rules.output.items, verdict, head, unclean.found), reason);
}
