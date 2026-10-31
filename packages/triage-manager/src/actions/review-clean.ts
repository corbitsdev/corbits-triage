import { type } from "arktype";
import { counted } from "@corbits/common";
import { CodeReviewOutput, PRIORITIES, RULE_GATES, rulesGate, ThreadRead, VERDICTS, type ActionKind, type CheckPack, type FindingsCondition, type VerdictWord } from "@corbits/triage-contracts";
import { DO_NAMES } from "@corbits/triage-workflows/actions/evaluate";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { awaitsText, type Verdict } from "@corbits/triage-workflows/logic/render";
import { LIFETIME_MS, storedReviewer, TakeOutput } from "./manager.js";

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
 * deadline reported nothing, and one of another head says nothing of this one. A comment id kept only on the code-review
 * event is joined onto the finding it belongs to, so this pass can match the read by that id.
 */
function reviewOf({ taken, review, reviewRun, reviewers, head, commentThreads }: TakeOutput, verdict: Verdict, scope: Scope): Reviewed | undefined {
  const part = TakenPart(taken);
  if (part instanceof type.errors) return undefined;
  const { codeReview } = part;
  const leftOut = scope.skipped !== undefined && rulesGate(codeReview.rules, verdict.checks).open;
  if (!codeReview.on || leftOut) return undefined;
  if (!scope.reviewed) return { incomplete: "Code review did not run on this head." };
  const stored = head === undefined ? undefined : storedReviewer(reviewers, head);
  const reported = head === undefined || (verdict.headSha !== null && verdict.headSha !== head) ? undefined : (review ?? stored?.review);
  if (!reported) return { incomplete: "Code review did not report on this head." };
  if (reported.budgetExhausted || reported.complete !== true) return { incomplete: "Code review did not read the whole change on this head." };
  const runId = review !== undefined ? reviewRun : stored?.runId;
  return { findings: withEventThreads(reported.comments, runId, commentThreads) };
}

/**
 * `comments` with the thread the code-review event of `runId` keeps for each finding that has none of its own. Matched
 * by the event's id, in the review's order: a list that does not line up, or a null, invents nothing, and a missing
 * thread with no read is not resolved. The event's stored state comes with the id. A pass that asked for the id still
 * releases only when the read is resolved.
 */
function withEventThreads(comments: readonly Finding[], runId: string | undefined, posted: TakeOutput["commentThreads"]): Finding[] {
  const row = runId === undefined ? undefined : posted?.find((item) => item.runId === runId);
  if (row === undefined || row.threads.length !== comments.length) return [...comments];
  return comments.map(function joined(finding, index) {
    if (finding.thread !== undefined) return finding;
    const thread = row.threads[index];
    return thread === null || thread === undefined ? finding : { ...finding, thread };
  });
}

/** The findings `condition` does not allow. */
function openUnder(condition: FindingsCondition, findings: readonly Finding[]): Finding[] {
  if ("any" in condition) return condition.any ? [] : [...findings];
  const ceiling = PRIORITIES.indexOf(condition.above);
  return findings.filter((finding) => finding.priority <= ceiling);
}

/**
 * Whether `finding` is released and no longer holds. One with no thread id was never posted inline, so it is not
 * released. An id this pass asked for is released only by a read of resolved: a missing read is not resolved, and a
 * stored resolved is not trusted for an id the pass asked for and did not get back. Done records that id as untouched,
 * so a later pass that does not ask cannot treat the failed read as resolved. When the pass asked for no id on
 * this head — `threads` omitted, empty, or only ids that are not on these findings — only a stored resolved releases
 * it. An id on this head the list left out, while it did ask for another id on this head, still holds: the cap dropped
 * it, so its stored state is not trusted. Outdated is not resolved, so it does not release. Not `findingOpen`, which
 * treats outdated as not open.
 */
function released(finding: Finding, asked: readonly number[] | undefined, reads: readonly ThreadRead[], currentIds: ReadonlySet<number>): boolean {
  const thread = finding.thread;
  if (thread === undefined) return false;
  if (asked?.includes(thread.id) === true) return reads.some((read) => read.id === thread.id && read.state === "resolved");
  const readingThisHead = asked !== undefined && asked.some((id) => currentIds.has(id));
  if (readingThisHead) return false;
  return thread.state === "resolved";
}

function findingsText(condition: FindingsCondition, count: number): string {
  const found = counted(count, "finding", "findings");
  return "above" in condition ? `${found} at ${condition.above} or above` : found;
}

/** Why the review does not meet `condition`, if it does not. Findings a resolved thread released are not counted. */
function unmet(condition: FindingsCondition, reviewed: Reviewed, asked: readonly number[] | undefined, reads: readonly ThreadRead[]): string | undefined {
  if ("incomplete" in reviewed) return reviewed.incomplete;
  const currentIds = new Set(reviewed.findings.flatMap((item) => (item.thread === undefined ? [] : [item.thread.id])));
  const holding = reviewed.findings.filter((finding) => !released(finding, asked, reads, currentIds));
  const open = openUnder(condition, holding).length;
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
  "findingThreads?": { output: { reads: ThreadRead.array(), "unread?": "string" } },
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
  const asked = parsed.take.output.threads;
  const reads = parsed.findingThreads?.output.reads ?? [];
  const notes: string[] = [];
  const actions = verdict.actions.map(function held(action): Action {
    if (!("effectId" in action) || "held" in action) return action;
    const condition = conditionOf(pack, action.list, action.index, action.kind);
    const reason = condition && unmet(condition, reviewed, asked, reads);
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
