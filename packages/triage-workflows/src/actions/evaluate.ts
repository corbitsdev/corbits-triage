import type { EffectContext } from "@intx/workflow";
import { checkName, FAILED_LABEL, hostKinds, marksWaiting, ownedLabels, repoSourceOf, VERDICT_LABELS, type ActionKind, type CheckPack, type RepoSource, type Step } from "@corbits/triage-contracts";
import { type } from "arktype";
import { ciRefusal } from "@corbits/github-reads";
import { approvalHeldBy, changesWanted, heldApprovals, holdDos, packApproves, stepActions, type ActionInput, type SuggestedAction } from "../logic/actions.js";
import type { CheckResult, DeterministicResult, PrFacts } from "../logic/checks.js";
import { errorText } from "@corbits/common";
import { unrunnable } from "../logic/execute-do.js";
import type { Item } from "../logic/item.js";
import { askedQuestionIds, focusedPartRequests, INSTRUCTED_QUESTION, prepareQualityEvaluation, verdictRequest, VERDICT_CHOICES, VERDICT_QUESTION, type FocusedParts, type JudgeRequest, type PolicyRule, type QualityEvaluation } from "../logic/quality.js";
import { choiceOver, decidesByModel, degradedVerdict, evaluateModel, parseAnswers, separateSlices, renderVerdict, splitLabelled, summarize, toMirrorRequest, type BacklogSummary, type ParsedAnswers, type RenderOutput, type Verdict, type WaitingMark } from "../logic/render.js";
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

/** A degraded verdict names no head: its facts may be only what a failed read named. */
function stamp(it: Item, headSha: string | null) {
  return { repo: it.facts.repo, number: it.facts.number, headSha, ...(it.repoSource && { repoSource: it.repoSource }), ...(it.appLogin && { appLogin: it.appLogin }) };
}

/**
 * Merges the answers of each reply that is well formed and answers only its own request's questions, so a bad reply
 * leaves only its own questions unanswered.
 */
function answersOf(requests: JudgeRequest[], answered: unknown[]): ParsedAnswers {
  const decisions: ParsedAnswers["decisions"] = {};
  const instructed: Array<number | undefined> = [];
  for (const [index, reply] of answered.entries()) {
    const { judge } = (stepJson(reply) ?? {}) as Judgment;
    const parsed = typeof judge === "string" ? parseAnswers(judge) : undefined;
    const asked = new Set(requests[index]!.questions.map((question) => question.id));
    const accepted = parsed && !parsed.malformed && Object.keys(parsed.decisions).every((id) => asked.has(id)) ? parsed.decisions : undefined;
    if (asked.has(INSTRUCTED_QUESTION.id)) {
      const answer = accepted?.[INSTRUCTED_QUESTION.id];
      instructed.push(answer?.type === "noul" ? answer.noul : undefined);
    }
    if (accepted) Object.assign(decisions, accepted);
  }
  // The most confident yes stands; a request that left it unanswered leaves it unanswered for the pull request.
  delete decisions[INSTRUCTED_QUESTION.id];
  if (instructed.length > 0 && instructed.every((noul) => noul !== undefined)) decisions[INSTRUCTED_QUESTION.id] = { id: INSTRUCTED_QUESTION.id, type: "noul", noul: Math.max(...instructed) };
  return { decisions, malformed: false };
}

function errorOf(answered: unknown[]): Judgment {
  const errors = new Set<string>();
  for (const reply of answered) {
    const { judgeError } = (stepJson(reply) ?? {}) as Judgment;
    if (typeof judgeError === "string") errors.add(judgeError);
  }
  return errors.size > 0 ? { judgeError: [...errors].join("; ") } : {};
}

/** Takes one reply per request off the front of `replies`. */
export function repliesTo(requests: JudgeRequest[], replies: unknown[]): unknown[] {
  return requests.map(() => replies.shift());
}

/** The names the verdict question was evaluated with, kept when the portal renames a rule so the model reads the same state. */
const VERDICT_RULE_NAMES: ReadonlyMap<string, string> = new Map([
  ["no-merge-conflicts", "No merge conflicts"],
  ["no-forbidden-paths", "No forbidden paths"],
  ["not-a-draft", "Not a draft"],
  ["no-changes-requested", "No changes requested"],
]);

/** A rule as the verdict question reads it; a judged rule scored out of 100 says how likely it passes, and a score rule names its level. */
function policyRule(pack: CheckPack, c: CheckResult): PolicyRule {
  const pass = c.output.kind === "score" ? Math.round(c.output.score) / 100 : undefined;
  const level = c.output.kind === "level" ? c.output.level : undefined;
  return { name: VERDICT_RULE_NAMES.get(c.check) ?? checkName(pack, c.check), judged: c.kind === "model", result: c.result, reason: c.reason, evidence: c.evidence, ...(pass !== undefined && { pass }), ...(level !== undefined && { level }) };
}

/** Whether the verdict question is asked in the first round: no judged rule is asked before it. */
export function choiceFirst({ requests }: QualityEvaluation): boolean {
  return requests.length === 0;
}

/**
 * The verdict question once the judged rules' first answers are in, or why it cannot be asked; undefined when the head
 * is not judged, or a first call failed or left a rule unanswered and the verdict degrades anyway.
 */
export function choiceOf(it: Item, evaluation: QualityEvaluation, first: unknown[]): { request: JudgeRequest } | { judgeError: string } | undefined {
  if (!it.det.needsJudgment || !decidesByModel(it.det) || !it.pack || it.judgeLimitExceeded || errorOf(first).judgeError !== undefined) return undefined;
  const { facts, det } = it;
  const { plan, focused, requests } = evaluation;
  const model = evaluateModel({ author: facts.author, repo: facts.repo, headSha: facts.headSha, det, answers: answersOf(requests, first), plan, focused, stack: facts.stack });
  const { deciding } = splitLabelled(det, model.checks);
  // A failed rule decides the verdict on its own, Fail or Unsure for a maintainer, so the verdict question is not asked.
  if (model.unanswered || model.instructed || [...det.checks, ...deciding].some((check) => check.result === "fail")) return undefined;
  return verdictRequest(facts, [...det.checks, ...deciding].map((c) => policyRule(it.pack!, c)));
}

export function partsOf(sources: DeterministicResult["sources"], { plan, focused, requests }: QualityEvaluation, answered: unknown[]): FocusedParts | undefined {
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

const FAILED_BUILD = "Triage couldn't run";

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

/**
 * A run that could not read the pull request says so where its verdict would stand: the failed label in place of any
 * verdict label on GitHub, a failed build status on Bitbucket Data Center. None without a known head, so a newer head is
 * never touched, nor where triage does not write the verdict.
 */
function degradedMark({ repo, number, headSha }: PrFacts, source: RepoSource, automatic: ActionKind[], owned: readonly string[], appLogin: string | undefined): WaitingMark | undefined {
  if (headSha === "" || !marksWaiting(source, automatic)) return undefined;
  const pull = { repo, number, onHead: headSha, ...(appLogin && { appLogin }) };
  const args = source === "bitbucket-datacenter"
    ? { ...pull, labels: [], owned: [], build: { state: "FAILED" as const, description: FAILED_BUILD } }
    : { ...pull, labels: [FAILED_LABEL], owned };
  return { effectId: `degraded:${repo.replace("/", "--")}:${number}:${headSha}`, repoSource: source, args };
}

function degradedOf(it: Item, reason: string): Verdict {
  const verdict = { ...stamp(it, null), ...degradedVerdict(reason), automatic: it.automatic ?? [], actions: [] };
  const request = toMirrorRequest(verdict, it.pack && ownedLabels(it.pack.labels));
  const mark = degradedMark(it.facts, repoSourceOf(it.repoSource), verdict.automatic, request.owned, it.appLogin);
  return { ...verdict, request, ...(mark && { mark }) };
}

type Rendered = Pick<RenderOutput, "checks" | "verdict" | "reason" | "degraded" | "waiting" | "labelled">;

/** Each labelling rule's result, and each rule that did not fail but still labels. */
function labelling(rendered: Rendered): CheckResult[] {
  const marked = rendered.checks.filter((c) => c.label !== undefined);
  return rendered.labelled ? [...rendered.labelled, ...marked] : marked;
}

function actionInputOf(it: Item, rendered: Rendered): ActionInput | undefined {
  if (!it.pack) return undefined;
  // Bitbucket Data Center has no labels, so there a labelling rule is only noted.
  const labelled = hostKinds(it.repoSource ?? "github").includes("labels") ? labelling(rendered) : undefined;
  return { facts: it.facts, checks: rendered.checks, verdict: rendered.verdict, reason: rendered.reason, pack: it.pack, labelled };
}

/** The Dos of `steps` on a rendered item, each held as the run may or may not write it. */
export function suggestedDos(it: Item, rendered: Rendered, steps: readonly Step[]): SuggestedAction[] {
  const actionInput = actionInputOf(it, rendered);
  // A degraded verdict is incomplete, a waiting one is not made yet, and a draft or closed pull request is not decided, so nothing is suggested from any.
  const decided = rendered.degraded === null && rendered.waiting === undefined && (it.det.needsJudgment || rendered.verdict === "fail");
  const suggested = actionInput && decided ? stepActions(actionInput, steps) : [];
  return holdDos(heldApprovals(suggested, approvalHeldBy(rendered.verdict, it.facts.checks), it.facts.checks), it.automatic ?? []);
}

/** Takes the item's own chunk replies off the front of `replies` and `partReplies`. */
function verdictOf(it: Item, replies: unknown[], partReplies: unknown[]): Verdict {
  if (it.error !== undefined) return degradedOf(it, it.error);
  try {
    // Rules recorded this same pure split as the judge's chunks.
    const evaluation = prepareQualityEvaluation(it.facts, it.det.sources);
    const { plan, focused: asked, requests } = evaluation;
    const first = it.det.needsJudgment ? repliesTo(requests, replies) : [];
    const choice = choiceOf(it, evaluation, first);
    const asking = choice && "request" in choice ? choice.request : undefined;
    const early = asking && choiceFirst(evaluation) ? repliesTo([asking], replies) : [];
    const parts = partsOf(it.det.sources, evaluation, first);
    const later = parts ? repliesTo(parts.requests, partReplies) : [];
    const late = asking && !choiceFirst(evaluation) ? repliesTo([asking], partReplies) : [];
    const focused = parts && asked ? { ...asked, parts: parts.asked } : asked;
    // Follow-up replies only name files, so one that failed or came back malformed never costs the first answers.
    const { judgeError } = it.det.needsJudgment ? { ...it, ...errorOf([...first, ...early, ...late]) } : it;
    const choiceReply = [...early, ...late][0];
    const choiceAsked = asking && choiceReply ? { requests: [asking], replies: [choiceReply] } : { requests: [], replies: [] };
    // The verdict request's instructed answer counts with the first round's; its verdict answer is the choice.
    const { [VERDICT_QUESTION.id]: verdictAnswer, ...decisions } = answersOf([...requests, ...(parts?.requests ?? []), ...choiceAsked.requests], [...first, ...later, ...choiceAsked.replies]).decisions;
    const answers = { decisions, malformed: false };
    const answered = choiceOver(verdictAnswer, VERDICT_CHOICES);
    const rendered = renderVerdict({
      author: it.facts.author, repo: it.facts.repo, repoSource: repoSourceOf(it.repoSource), headSha: it.facts.headSha, det: it.det, answers, plan, focused, stack: it.facts.stack, judgeError,
      judgeLimitExceeded: it.judgeLimitExceeded, judgeSkipped: it.judgeSkipped, reviewers: it.facts.reviewers, choice: answered,
      ...(choice && "judgeError" in choice && { choiceRefused: choice.judgeError }), ...(it.noWait && { noWait: it.noWait }),
    });
    const actionInput = actionInputOf(it, rendered);
    const wanted = actionInput && changesWanted(actionInput);
    const held = approvalHeldBy(rendered.verdict, it.facts.checks);
    const automatic = it.automatic ?? [];
    const actions = suggestedDos(it, rendered, it.pack?.actions[rendered.verdict] ?? []);
    const feedback = it.blocksOn ? rendered.feedback : withDos(rendered.feedback, actions);
    // What reading the policy left out is said on every verdict, so the policy can be fixed.
    const reasons = [...rendered.reasons, ...(it.pack?.dropped ?? [])];
    const labels = it.pack && !rendered.waiting ? [it.pack.labels[rendered.verdict]] : rendered.labels;
    const owned = it.pack ? ownedLabels(it.pack.labels) : undefined;
    const mark = rendered.waiting && waitingMark(repoSourceOf(it.repoSource), it.facts, automatic, it.pack?.labels ?? VERDICT_LABELS, it.facts.checks !== "none", it.appLogin);
    const verdict = {
      ...stamp(it, it.facts.headSha), ...rendered, labels, reasons, feedback, automatic, actions,
      ...(it.pack && packApproves(it.pack) && { approvable: held === undefined }), ...(wanted !== undefined && { changesWanted: wanted }),
      ...(mark && { mark }), ...(it.facts.state === "closed" && { closed: true as const }),
    };
    return { ...verdict, request: toMirrorRequest(verdict, owned, it.source) };
  } catch (e) {
    return degradedOf(it, `render failed: ${errorText(e)}`);
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
