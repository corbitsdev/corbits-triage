import type { EffectContext } from "@intx/workflow";
import { checkName, ownedLabels, repoSourceOf, VERDICT_LABELS, type ActionKind, type CheckPack } from "@corbits/triage-contracts";
import { type } from "arktype";
import { ciRefusal } from "@corbits/github-reads";
import { approvalHeldBy, changesWanted, evaluateActions, heldApprovals, holdDos, packApproves, type SuggestedAction } from "../logic/actions.js";
import { hasModelChecks, type CheckResult, type DeterministicResult, type PrFacts } from "../logic/checks.js";
import { errorText } from "@corbits/common";
import { unrunnable } from "../logic/execute-do.js";
import type { Item, Judged } from "../logic/item.js";
import { askedQuestionIds, focusedPartRequests, judgeKey, prepareQualityEvaluation, verdictRequest, VERDICT_CHOICES, VERDICT_QUESTION, type FocusedParts, type JudgeRequest, type PolicyRule, type QualityEvaluation, type VerdictChoice } from "../logic/quality.js";
import { choiceOver, degradedVerdict, evaluateModel, isReusableReply, parseAnswers, separateSlices, renderVerdict, summarize, toMirrorRequest, type BacklogSummary, type ParsedAnswers, type Verdict } from "../logic/render.js";
import { stepJson } from "../logic/step-json.js";
import { waitingMark } from "./waiting.js";

export interface EvaluateInput {
  items: Item[];
  batch: boolean;
  judge?: { output: unknown[] };
  /** Focused's follow-up file questions, asked only for items whose first answers failed it. */
  judgeParts?: { output: unknown[] };
}

export type Judgment = Pick<Item, "judge" | "judgeError">;

export type EvaluateOutput = Verdict | { items: Verdict[]; summary: BacklogSummary };

// Items are unchecked so a malformed one degrades its own verdict instead of failing the batch.
export const Input = type({ items: "object[]", batch: "boolean", "judge?": { output: "unknown[]" }, "judgeParts?": { output: "unknown[]" } });

/** A facts failure or malformed input reaches this step without facts: the verdict then names no head and is degraded. */
function stamp(facts: PrFacts | undefined, it?: Item) {
  return { repo: facts?.repo ?? "", number: facts?.number ?? 0, headSha: facts?.headSha ?? null, ...(it?.repoSource && { repoSource: it.repoSource }) };
}

/**
 * Merges the answers of each reply that is well formed and answers only its own request's questions, so a bad reply
 * leaves only its own questions unanswered.
 */
function answersOf(requests: JudgeRequest[], answered: Array<[string, unknown]>): ParsedAnswers {
  const decisions: ParsedAnswers["decisions"] = {};
  for (const [index, [, reply]] of answered.entries()) {
    const { judge } = (stepJson(reply) ?? {}) as Judgment;
    const parsed = typeof judge === "string" ? parseAnswers(judge) : undefined;
    const asked = new Set(requests[index]!.questions.map((question) => question.id));
    if (parsed && !parsed.malformed && Object.keys(parsed.decisions).every((id) => asked.has(id))) Object.assign(decisions, parsed.decisions);
  }
  return { decisions, malformed: false };
}

function errorOf(answered: Array<[string, unknown]>): Judgment {
  const errors = new Set<string>();
  for (const [, reply] of answered) {
    const { judgeError } = (stepJson(reply) ?? {}) as Judgment;
    if (typeof judgeError === "string") errors.add(judgeError);
  }
  return errors.size > 0 ? { judgeError: [...errors].join("; ") } : {};
}

export function repliesTo(it: Item, requests: JudgeRequest[], replies: unknown[]): Array<[string, unknown]> {
  return requests.map(function replyTo(request): [string, unknown] {
    const key = judgeKey(request);
    const carried = it.judged?.[key];
    return [key, carried !== undefined ? { judge: carried } : replies.shift()];
  });
}

// The run log carries the verdict inline and the hub mails the answers back; on the judge eval the answers a verdict
// keeps are a few hundred bytes at the median and about 20 KB on the largest pull request, so the rare outlier is
// re-asked in part rather than carried whole.
const MAX_JUDGED_BYTES = 16 * 1024;

/** The answers a later run of the same head can reuse: each that came back whole and decisive, up to `MAX_JUDGED_BYTES`. */
function reusable(answered: Array<[string, unknown]>): Judged {
  const judged: Judged = {};
  let bytes = 0;
  for (const [key, reply] of answered) {
    const { judge, judgeError } = (stepJson(reply) ?? {}) as Judgment;
    if (typeof judge !== "string" || judgeError !== undefined || !isReusableReply(judge)) continue;
    bytes += key.length + judge.length;
    if (bytes > MAX_JUDGED_BYTES) break;
    judged[key] = judge;
  }
  return judged;
}

/** A rule as the verdict question reads it; a judged rule scored out of 100 says how likely it passes, and a score rule names its level. */
function policyRule(pack: CheckPack, c: CheckResult): PolicyRule {
  const pass = c.output.kind === "score" ? Math.round(c.output.score) / 100 : undefined;
  const level = c.output.kind === "level" ? c.output.level : undefined;
  return { name: checkName(pack, c.check), judged: c.kind === "model", result: c.result, reason: c.reason, evidence: c.evidence, ...(pass !== undefined && { pass }), ...(level !== undefined && { level }) };
}

/** Whether the verdict question is asked with the judged rules' first calls: when none of those is left to ask, their answers are already known. */
export function choiceFirst(it: Item, { requests }: QualityEvaluation): boolean {
  return requests.every((request) => it.judged?.[judgeKey(request)] !== undefined);
}

/**
 * The verdict question once the judged rules' first answers are in, or why it cannot be asked; undefined when the head
 * is not judged, or a first call failed or left a rule unanswered and the verdict degrades anyway.
 */
export function choiceOf(it: Item, evaluation: QualityEvaluation, first: Array<[string, unknown]>): { request: JudgeRequest } | { judgeError: string } | undefined {
  if (!it.det.needsJudgment || !hasModelChecks(it.det.sources) || !it.pack || it.judgeLimitExceeded || errorOf(first).judgeError !== undefined) return undefined;
  const { facts, det } = it;
  const { plan, focused, requests } = evaluation;
  const model = evaluateModel({ author: facts.author, repo: facts.repo, headSha: facts.headSha, det, answers: answersOf(requests, first), plan, focused, stack: facts.stack });
  // A judged rule that failed decides Fail on its own, so the verdict question is not asked.
  if (model.unanswered || model.checks.some((check) => check.result === "fail")) return undefined;
  return verdictRequest(facts, [...det.checks, ...model.checks].map((c) => policyRule(it.pack!, c)));
}

function choiceAnswer(request: JudgeRequest, reply: [string, unknown]): Record<VerdictChoice, number> | undefined {
  return choiceOver(answersOf([request], [reply]).decisions[VERDICT_QUESTION.id], VERDICT_CHOICES);
}

export function partsOf(sources: DeterministicResult["sources"], { plan, focused, requests }: QualityEvaluation, answered: Array<[string, unknown]>): FocusedParts | undefined {
  const failing = focused && sources ? separateSlices(answersOf(requests, answered), focused, askedQuestionIds(sources, plan, focused)) : [];
  return failing.length > 0 ? focusedPartRequests(requests, failing) : undefined;
}

const DO_NAMES: Record<ActionKind, string> = {
  labels: "label",
  assign: "assign",
  "request-review": "request review",
  comment: "comment",
  approve: "approve",
  "request-changes": "request changes",
  close: "close",
  merge: "merge",
};

const PENDING_CI = `${ciRefusal("pending")}.`;

function doNames(actions: SuggestedAction[]): string {
  return [...new Set(actions.map((action) => DO_NAMES[action.kind]))].join(", ");
}

/** What Triage does on this head unattended and what waits, on checks or on a person, closing the comment; a Do that cannot run is left out. */
function withDos(feedback: string, actions: SuggestedAction[]): string {
  if (!feedback) return feedback;
  const runnable = actions.filter((action) => "effectId" in action && unrunnable(action) === undefined);
  const held = runnable.filter((action) => "held" in action);
  const groups: Array<[string, SuggestedAction[]]> = [
    ["Triage will", runnable.filter((action) => !("held" in action))],
    ["Waiting for checks to finish:", held.filter((action) => action.reason === PENDING_CI)],
    ["Waiting on a maintainer to approve:", held.filter((action) => action.reason !== PENDING_CI)],
  ];
  const lines = groups.filter(([, group]) => group.length > 0).map(([lead, group]) => `${lead} ${doNames(group)}.`);
  return lines.length ? `${feedback}\n\n${lines.join("\n")}` : feedback;
}

/** Takes the item's own chunk replies off the front of `replies` and `partReplies`; requests an earlier run answered took none. */
function verdictOf(it: Item, replies: unknown[], partReplies: unknown[]): Verdict {
  if (it.error !== undefined) {
    const verdict = { ...stamp(undefined, it), ...degradedVerdict(it.error), automatic: it.automatic ?? [], actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
  try {
    // Rules recorded this same pure split as the judge's chunks, less the requests an earlier run answered.
    const evaluation = prepareQualityEvaluation(it.facts, it.det.sources);
    const { plan, focused: asked, requests } = evaluation;
    const first = it.det.needsJudgment ? repliesTo(it, requests, replies) : [];
    const choice = choiceOf(it, evaluation, first);
    const asking = choice && "request" in choice ? choice.request : undefined;
    const early = asking && choiceFirst(it, evaluation) ? repliesTo(it, [asking], replies) : [];
    const parts = partsOf(it.det.sources, evaluation, first);
    const later = parts ? repliesTo(it, parts.requests, partReplies) : [];
    const late = asking && !choiceFirst(it, evaluation) ? repliesTo(it, [asking], partReplies) : [];
    const focused = parts && asked ? { ...asked, parts: parts.asked } : asked;
    // Follow-up replies only name files, so one that failed or came back malformed never costs the first answers.
    const { judgeError } = it.det.needsJudgment ? { ...it, ...errorOf([...first, ...early, ...late]) } : it;
    const answers = answersOf([...requests, ...(parts?.requests ?? [])], [...first, ...later]);
    const choiceReply = [...early, ...late][0];
    const answered = asking && choiceReply ? choiceAnswer(asking, choiceReply) : undefined;
    const rendered = renderVerdict({
      author: it.facts.author, repo: it.facts.repo, headSha: it.facts.headSha, det: it.det, answers, plan, focused, stack: it.facts.stack, judgeError,
      judgeLimitExceeded: it.judgeLimitExceeded, judgeSkipped: it.judgeSkipped, reviewers: it.facts.reviewers, choice: answered,
      ...(choice && "judgeError" in choice && { choiceRefused: choice.judgeError }), ...(it.noWait && { noWait: it.noWait }),
    });
    const actionInput = it.pack ? { facts: it.facts, checks: rendered.checks, verdict: rendered.verdict, reason: rendered.reason, pack: it.pack } : undefined;
    // A degraded verdict is incomplete, a waiting one is not made yet, and a draft or closed pull request is not decided, so nothing is suggested from any.
    const decided = rendered.degraded === null && rendered.waiting === undefined && (it.det.needsJudgment || rendered.verdict === "fail");
    const suggested = actionInput && decided ? evaluateActions(actionInput) : [];
    const wanted = actionInput && changesWanted(actionInput);
    const held = approvalHeldBy(rendered.verdict, it.facts.checks);
    const automatic = it.automatic ?? [];
    const actions = holdDos(heldApprovals(suggested, held, it.facts.checks), automatic);
    const judged = reusable([...first, ...early, ...later, ...late]);
    const feedback = withDos(rendered.feedback, actions);
    // What reading the policy left out is said on every verdict, so the policy can be fixed.
    const reasons = [...rendered.reasons, ...(it.pack?.dropped ?? [])];
    const labels = it.pack && !rendered.waiting ? [it.pack.labels[rendered.verdict]] : rendered.labels;
    const owned = it.pack ? ownedLabels(it.pack.labels) : undefined;
    const mark = rendered.waiting && waitingMark(repoSourceOf(it.repoSource), it.facts, automatic, it.pack?.labels ?? VERDICT_LABELS, it.facts.checks !== "none");
    const verdict = {
      ...stamp(it.facts, it), ...rendered, labels, reasons, feedback, automatic, actions, ...(Object.keys(judged).length > 0 && { judged }),
      ...(it.pack && packApproves(it.pack) && { approvable: held === undefined }), ...(wanted !== undefined && { changesWanted: wanted }),
      ...(mark && { mark }), ...(it.facts.state === "closed" && { closed: true as const }),
    };
    return { ...verdict, request: toMirrorRequest(verdict, owned, it.source) };
  } catch (e) {
    const verdict = { ...stamp(undefined, it), ...degradedVerdict(`render failed: ${errorText(e)}`), automatic: it.automatic ?? [], actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
}

export async function evaluate(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<EvaluateOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`evaluate: invalid input: ${parsed.summary}`);
  const { items, batch, judge, judgeParts } = parsed as EvaluateInput;
  const replies = [...(judge?.output ?? [])];
  const partReplies = [...(judgeParts?.output ?? [])];
  const verdicts = items.map((it) => verdictOf(it, replies, partReplies));
  return batch ? { items: verdicts, summary: summarize(verdicts) } : verdicts[0]!;
}
