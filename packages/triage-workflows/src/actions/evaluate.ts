import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { evaluateActions } from "../logic/actions.js";
import type { PrFacts } from "../logic/checks.js";
import { errorText } from "../logic/extract.js";
import type { Item } from "../logic/item.js";
import { prepareQualityEvaluation } from "../logic/quality.js";
import { degradedVerdict, parseAnswers, renderVerdict, summarize, toMirrorRequest, type BacklogSummary, type Verdict } from "../logic/render.js";
import { stepJson } from "../logic/step-json.js";

/** The rules items, merged with the judge map's per-chunk outputs, in chunk order, when the judge ran. */
interface EvaluateInput {
  items: Item[];
  batch: boolean;
  judge?: { output: unknown[] };
}

/** The judge's answer for one chunk, or for one item once its chunks are merged; empty when it was not asked. */
export type Judgment = Pick<Item, "judge" | "judgeError">;

export type EvaluateOutput = Verdict | { items: Verdict[]; summary: BacklogSummary };

// Items are unchecked so a malformed one degrades its own verdict instead of failing the batch.
const Input = type({ items: "object[]", batch: "boolean", "judge?": { output: "unknown[]" } });

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

/** Takes the item's own chunk replies off the front of `replies`. */
function verdictOf(it: Item, replies: unknown[]): Verdict {
  if (it.error !== undefined) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(it.error), cleanupMode: it.cleanupMode, actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
  try {
    // Rules recorded this same pure split as the judge's chunks, so the item's replies are the next `requests.length`.
    const { candidates, requests } = prepareQualityEvaluation(it.facts, it.det.sources);
    const { judge, judgeError } = it.det.needsJudgment ? { ...it, ...judgmentOf(replies.splice(0, requests.length)) } : it;
    const answers = judge !== undefined ? parseAnswers(judge) : null;
    const rendered = renderVerdict({ author: it.facts.author, det: it.det, answers, candidates, judgeError, judgeLimitExceeded: it.judgeLimitExceeded, judgeSkipped: it.judgeSkipped, reviewers: it.facts.reviewers });
    // A degraded verdict is incomplete, so nothing is suggested from it.
    const actions = it.pack && rendered.degraded === null ? evaluateActions({ facts: it.facts, checks: rendered.checks, pack: it.pack, roles: it.roles ?? {} }) : [];
    const verdict = { ...stamp(it.facts), ...rendered, cleanupMode: it.cleanupMode, actions };
    return { ...verdict, request: toMirrorRequest(verdict) };
  } catch (e) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(`render failed: ${errorText(e)}`), cleanupMode: it.cleanupMode, actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
}

export async function evaluate(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<EvaluateOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`evaluate: invalid input: ${parsed.summary}`);
  const { items, batch, judge } = parsed as EvaluateInput;
  const replies = [...(judge?.output ?? [])];
  const verdicts = items.map((it) => verdictOf(it, replies));
  return batch ? { items: verdicts, summary: summarize(verdicts) } : verdicts[0]!;
}
