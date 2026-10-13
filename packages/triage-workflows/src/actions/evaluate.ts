import type { EffectContext } from "@intx/workflow";
import { packMergeThreshold } from "@corbits/triage-contracts";
import { type } from "arktype";
import { approvalHeldBy, changesWanted, evaluateActions, heldApprovals, packApproves } from "../logic/actions.js";
import type { PrFacts } from "../logic/checks.js";
import { errorText } from "../logic/extract.js";
import type { Item, Judged } from "../logic/item.js";
import { focusedPartRequests, judgeKey, prepareQualityEvaluation, type FocusedParts, type FocusedPlan, type JudgeRequest } from "../logic/quality.js";
import { degradedVerdict, isReusableReply, parseAnswers, separateSlices, renderVerdict, summarize, toMirrorRequest, type BacklogSummary, type Verdict } from "../logic/render.js";
import { stepJson } from "../logic/step-json.js";

/** The rules items, merged with the judge maps' per-chunk outputs, in chunk order, when the judge ran. */
export interface EvaluateInput {
  items: Item[];
  batch: boolean;
  judge?: { output: unknown[] };
  /** Focused's follow-up file questions, asked only for items whose first answers failed it. */
  judgeParts?: { output: unknown[] };
}

/** The judge's answer for one chunk, or for one item once its chunks are merged; empty when it was not asked. */
export type Judgment = Pick<Item, "judge" | "judgeError">;

export type EvaluateOutput = Verdict | { items: Verdict[]; summary: BacklogSummary };

// Items are unchecked so a malformed one degrades its own verdict instead of failing the batch.
export const Input = type({ items: "object[]", batch: "boolean", "judge?": { output: "unknown[]" }, "judgeParts?": { output: "unknown[]" } });

/** A facts failure or malformed input reaches this step without facts: the verdict then names no head and is degraded. */
function stamp(facts: PrFacts | undefined) {
  return { repo: facts?.repo ?? "", number: facts?.number ?? 0, headSha: facts?.headSha ?? null };
}

/** Joins one item's chunk answers; only the chunks that failed contribute an error, each distinct error once. */
function judgmentOf(replies: unknown[]): Judgment {
  const answers: string[] = [];
  const errors = new Set<string>();
  for (const reply of replies) {
    const { judge, judgeError } = (stepJson(reply) ?? {}) as Judgment;
    if (typeof judge === "string") answers.push(judge);
    if (typeof judgeError === "string") errors.add(judgeError);
  }
  return { ...(answers.length > 0 ? { judge: answers.join("\n") } : {}), ...(errors.size > 0 ? { judgeError: [...errors].join("; ") } : {}) };
}

/** The item's reply to each of its requests by `judgeKey`: an earlier run's answer where it has one, else the next of `replies`. */
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

/** Focused's follow-up requests about the slices its first answers call a separate change, if any. */
export function partsOf(focused: FocusedPlan | undefined, requests: JudgeRequest[], answered: Array<[string, unknown]>): FocusedParts | undefined {
  const { judge } = judgmentOf(answered.map(([, reply]) => reply));
  const failing = focused && judge !== undefined ? separateSlices(parseAnswers(judge), focused) : [];
  return failing.length > 0 ? focusedPartRequests(requests, failing) : undefined;
}

/** Takes the item's own chunk replies off the front of `replies` and `partReplies`; requests an earlier run answered took none. */
function verdictOf(it: Item, replies: unknown[], partReplies: unknown[]): Verdict {
  if (it.error !== undefined) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(it.error, packMergeThreshold(it.pack)), cleanupMode: it.cleanupMode, actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
  try {
    // Rules recorded this same pure split as the judge's chunks, less the requests an earlier run answered.
    const { plan, focused: asked, requests } = prepareQualityEvaluation(it.facts, it.det.sources);
    const first = it.det.needsJudgment ? repliesTo(it, requests, replies) : [];
    const parts = partsOf(asked, requests, first);
    const answered = parts ? [...first, ...repliesTo(it, parts.requests, partReplies)] : first;
    const focused = parts && asked ? { ...asked, parts: parts.asked } : asked;
    const { judge, judgeError } = it.det.needsJudgment ? { ...it, ...judgmentOf(answered.map(([, reply]) => reply)) } : it;
    const answers = judge !== undefined ? parseAnswers(judge) : null;
    const rendered = renderVerdict({ author: it.facts.author, repo: it.facts.repo, headSha: it.facts.headSha, det: it.det, answers, plan, focused, judgeError, judgeLimitExceeded: it.judgeLimitExceeded, judgeSkipped: it.judgeSkipped, reviewers: it.facts.reviewers, threshold: packMergeThreshold(it.pack) });
    // A degraded verdict is incomplete, so nothing is suggested from it.
    const actionInput = it.pack && rendered.degraded === null ? { facts: it.facts, checks: rendered.checks, pack: it.pack, roles: it.roles ?? {} } : undefined;
    const suggested = actionInput ? evaluateActions(actionInput) : [];
    const wanted = actionInput && changesWanted(actionInput);
    const held = approvalHeldBy(rendered.merge.verdict, it.facts.checks);
    const actions = heldApprovals(suggested, held);
    const judged = reusable(answered);
    const verdict = { ...stamp(it.facts), ...rendered, cleanupMode: it.cleanupMode, actions, ...(Object.keys(judged).length > 0 && { judged }), ...(it.pack && packApproves(it.pack) && { approvable: held === undefined }), ...(wanted !== undefined && { changesWanted: wanted }) };
    return { ...verdict, request: toMirrorRequest(verdict) };
  } catch (e) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(`render failed: ${errorText(e)}`, packMergeThreshold(it.pack)), cleanupMode: it.cleanupMode, actions: [] };
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
