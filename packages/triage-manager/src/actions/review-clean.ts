import { type } from "arktype";
import { CodeReviewOutput, PRIORITIES, RULE_GATES, rulesGate, uncheckedNote, VERDICTS, type ActionKind, type CheckPack, type FindingsCondition, type VerdictWord } from "@corbits/triage-contracts";
import { DO_NAMES } from "@corbits/triage-workflows/actions/evaluate";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { awaitsText, type Verdict } from "@corbits/triage-workflows/logic/render";
import { LIFETIME_MS, storedReview, TakeOutput } from "./manager.js";

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES) });
const TakenPart = type({ codeReview: CodeReviewPart });

/** Both say the pull request may land, so by default neither runs past a review with any finding open. */
const CLEAN_KINDS: readonly ActionKind[] = ["approve", "merge"];
const NO_FINDINGS: FindingsCondition = { any: false };

const Scope = type({ reviewed: "boolean", "skipped?": "string" });
type Scope = typeof Scope.infer;

type Finding = CodeReviewOutput["comments"][number];

/** What code review says of the verdict's head: nothing, while the policy leaves it out; why it is incomplete; or its findings. */
type Reviewed = { incomplete: string } | { findings: Finding[] };

/**
 * The review of the verdict's head while the policy turns code review on. One the policy's `for` or `when` left out
 * counts as off, and one held back by failed or unsettled rules did not run. A review that failed or ran past its
 * deadline reported nothing, and one of another head says nothing of this one.
 */
function reviewOf({ taken, review, reviewers, head }: TakeOutput, verdict: Verdict, scope: Scope): Reviewed | undefined {
  const part = TakenPart(taken);
  if (part instanceof type.errors) return undefined;
  const { codeReview } = part;
  const leftOut = scope.skipped !== undefined && rulesGate(codeReview.rules, verdict.checks).open;
  if (!codeReview.on || leftOut) return undefined;
  if (!scope.reviewed) return { incomplete: "Code review did not run on this head." };
  const reported = head === undefined || (verdict.headSha !== null && verdict.headSha !== head) ? undefined : (review ?? storedReview(reviewers, head));
  if (!reported) return { incomplete: "Code review did not report on this head." };
  if (reported.budgetExhausted || reported.complete !== true) return { incomplete: "Code review did not read the whole change on this head." };
  const unchecked = reported.unchecked ?? 0;
  if (unchecked > 0) return { incomplete: uncheckedNote(unchecked) };
  return { findings: reported.comments };
}

/** The findings `condition` does not allow. */
function openUnder(condition: FindingsCondition, findings: readonly Finding[]): Finding[] {
  if ("any" in condition) return condition.any ? [] : [...findings];
  const ceiling = PRIORITIES.indexOf(condition.above);
  return findings.filter((finding) => finding.priority <= ceiling);
}

function findingsText(condition: FindingsCondition, count: number): string {
  const noun = count === 1 ? "finding" : "findings";
  return "above" in condition ? `${count} ${noun} at ${condition.above} or above` : `${count} ${noun}`;
}

/** Why the review does not meet `condition`, if it does not. */
function unmet(condition: FindingsCondition, reviewed: Reviewed): string | undefined {
  if ("incomplete" in reviewed) return reviewed.incomplete;
  const open = openUnder(condition, reviewed.findings).length;
  return open > 0 ? `Code review has ${findingsText(condition, open)} open on this head.` : undefined;
}

/** What a step of the policy allows of the review: its own `when.findings`, or for approve and merge, no finding at all. */
function conditionOf(pack: CheckPack | undefined, list: VerdictWord, index: number, kind: ActionKind): FindingsCondition | undefined {
  const own = pack?.actions[list][index]?.when?.findings;
  if (own !== undefined) return own;
  return CLEAN_KINDS.includes(kind) ? NO_FINDINGS : undefined;
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

type Action = Verdict["actions"][number];

/** `verdict` with `note` closing its comment, as said on the pull request and kept with the verdict. */
function noted(verdict: Verdict, note: string): Verdict {
  const feedback = verdict.feedback ? `${verdict.feedback}\n\n${note}` : note;
  const request = verdict.request && { ...verdict.request, comment: verdict.request.comment ? `${verdict.request.comment}\n\n${note}` : note };
  return { ...verdict, feedback, ...(request && { request }) };
}

/**
 * The pass's verdict once code review is in: its findings never change the verdict the rules made. Each Do whose step's
 * `when.findings` the review does not meet, by default an approve or merge with any finding open, is held for a person,
 * saying why, and named in the comment. A held approve leaves the head not approvable, so an approval Triage gave an
 * earlier head is taken back. A Do already held keeps its own reason, such as waiting for CI.
 */
export async function cleared(input: unknown): Promise<Verdict> {
  const parsed = ClearedInput(input);
  if (parsed instanceof type.errors) throw new Error(`cleared: ${parsed.summary}`);
  const { stopped } = parsed.take.output;
  const verdict = heldByReview(parsed);
  return stopped ? stoppedWaiting(verdict, stopped) : verdict;
}

function heldByReview(parsed: typeof ClearedInput.infer): Verdict {
  const verdict = parsed.evaluateRules.output;
  const reviewed = reviewOf(parsed.take.output, verdict, parsed.reviewScope.output);
  if (reviewed === undefined) return verdict;
  const pack = parsed.rules.output.items.find((item) => item.pack !== undefined)?.pack;
  const notes: string[] = [];
  const actions = verdict.actions.map(function held(action): Action {
    if (!("effectId" in action) || "held" in action) return action;
    const condition = conditionOf(pack, action.list, action.index, action.kind);
    const reason = condition && unmet(condition, reviewed);
    if (reason === undefined) return action;
    const name = DO_NAMES[action.kind];
    notes.push(`${name[0]!.toUpperCase()}${name.slice(1)} held: ${reason[0]!.toLowerCase()}${reason.slice(1)}`);
    return { ...action, held: true, reason };
  });
  if (notes.length === 0) return verdict;
  const approveHeld = actions.some((action) => action.kind === "approve" && "held" in action && !verdict.actions.includes(action));
  return noted({ ...verdict, actions, ...(approveHeld && verdict.approvable !== undefined && { approvable: false }) }, notes.join("\n"));
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
  return { ...noted({ ...verdict, actions }, note), reasons: [...verdict.reasons, note], ...(verdict.approvable !== undefined && { approvable: false }) };
}
