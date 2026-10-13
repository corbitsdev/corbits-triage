import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { judgeKey, prepareQualityEvaluation } from "../logic/quality.js";
import { Input, partsOf, repliesTo, type EvaluateInput } from "./evaluate.js";
import type { JudgeChunk } from "./rules.js";

/** Focused's follow-up calls, in item order; empty unless an item's first answers failed focused. */
export interface PartsOutput {
  chunks: JudgeChunk[];
}

/** Reads each item's first-round replies as evaluate does, and asks focused's file questions only where it failed. */
export async function parts(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<PartsOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`parts: invalid input: ${parsed.summary}`);
  const { items, judge } = parsed as EvaluateInput;
  const replies = [...(judge?.output ?? [])];
  const chunks = items.flatMap(function partChunks(it, item): JudgeChunk[] {
    if (it.error !== undefined || !it.det.needsJudgment) return [];
    const evaluation = prepareQualityEvaluation(it.facts, it.det.sources);
    const asked = partsOf(it.det.sources, evaluation, repliesTo(it, evaluation.requests, replies))?.requests ?? [];
    return asked.filter((request) => it.judged?.[judgeKey(request)] === undefined).map(({ state, questions }) => ({ item, state, questions }));
  });
  return { chunks };
}
