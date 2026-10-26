import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { prepareQualityEvaluation } from "../logic/quality.js";
import { choiceFirst, choiceOf, Input, partsOf, repliesTo, type EvaluateInput } from "./evaluate.js";
import type { JudgeChunk } from "./rules.js";

/** Focused's follow-up calls and the verdict questions the first calls' answers were needed for, in item order. */
export interface PartsOutput {
  chunks: JudgeChunk[];
}

/** Reads each item's first-round replies as evaluate does, asks focused's file questions only where it failed, then the verdict question. */
export async function parts(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<PartsOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`parts: invalid input: ${parsed.summary}`);
  const { items, judge } = parsed as EvaluateInput;
  const replies = [...(judge?.output ?? [])];
  const chunks = items.flatMap(function partChunks(it, item): JudgeChunk[] {
    if (it.error !== undefined || !it.det.needsJudgment) return [];
    const evaluation = prepareQualityEvaluation(it.facts, it.det.sources);
    const first = repliesTo(evaluation.requests, replies);
    const choice = choiceOf(it, evaluation, first);
    const asking = choice && "request" in choice ? [choice.request] : [];
    // A verdict question asked in the first round took its reply there.
    if (choiceFirst(evaluation)) repliesTo(asking, replies);
    const late = choiceFirst(evaluation) ? [] : asking;
    const asked = [...(partsOf(it.det.sources, evaluation, first)?.requests ?? []), ...late];
    return asked.map(({ state, questions }) => ({ item, state, questions }));
  });
  return { chunks };
}
