import { type } from "arktype";
import { BLOCK_KINDS, blockCleanSchema, CodeReviewOutput, RULE_GATES, rulesGate, SEVERITIES, type ActionKind } from "@corbits/triage-contracts";
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

/** Why the review is not clean: none reported, it read only part of the change, or a finding is at or above `below`. */
function uncleanBy(review: CodeReviewOutput | undefined, below: (typeof SEVERITIES)[number] | undefined): string | undefined {
  if (!review) return "Code review did not report on this head.";
  if (review.budgetExhausted || review.cut) return "Code review did not read the whole change on this head.";
  const floor = below === undefined ? 0 : SEVERITIES.indexOf(below);
  if (review.comments.some((finding) => severityAt(finding) >= floor)) return "Code review found problems on this head.";
  return undefined;
}

/** A Do already held keeps its own reason, such as waiting for CI. */
function hold<A extends object>(action: A, reason: string): A {
  const { effectId, kind, held } = action as { effectId?: unknown; kind?: unknown; held?: unknown };
  if (typeof effectId !== "string" || held === true || !HELD_KINDS.some((each) => each === kind)) return action;
  return { ...action, held: true, reason };
}

/**
 * Why approve and merge wait while the policy turns a check on. A check that can't run yet holds them until it can.
 * Code review must have run on the head and be clean as its block's `clean` says; one the policy's `for` or `when` left
 * out counts as off, and one held back by failed or unsettled rules did not run. A review that failed or ran past its
 * deadline reported nothing.
 */
function heldBy({ taken, review, reviewers, head }: TakeOutput, checks: unknown, scope: Scope): string | undefined {
  const part = BlocksPart(taken);
  if (part instanceof type.errors) return undefined;
  const { blocks, codeReview } = part;
  const waiting = blocks.filter((kind) => kind !== "code-review");
  if (waiting.length > 0) return `The policy's ${waiting.join(" and ")} check can't run yet.`;
  const leftOut = scope.skipped !== undefined && rulesGate(codeReview.rules, checks).open;
  if (!codeReview.on || leftOut) return undefined;
  if (!scope.reviewed) return "Code review did not run on this head.";
  return uncleanBy(review ?? (head === undefined ? undefined : storedReview(reviewers, head)), codeReview.clean?.below);
}

const ClearedInput = type({ take: { output: TakeOutput }, evaluateRules: { output: { checks: "unknown", actions: "object[]", "approvable?": "boolean" } }, reviewScope: { output: Scope } });

/**
 * The pass's verdict with its approve and merge Dos held for a person, saying why, while the policy's checks are not
 * clean on its head. Such a head is not approvable, so an approval Triage gave an earlier head is taken back.
 */
export async function cleared(input: unknown): Promise<Record<string, unknown>> {
  const parsed = ClearedInput(input);
  if (parsed instanceof type.errors) throw new Error(`cleared: ${parsed.summary}`);
  const verdict = parsed.evaluateRules.output;
  const reason = heldBy(parsed.take.output, verdict.checks, parsed.reviewScope.output);
  if (reason === undefined) return verdict;
  return { ...verdict, actions: verdict.actions.map((action) => hold(action, reason)), ...(verdict.approvable !== undefined && { approvable: false }) };
}
