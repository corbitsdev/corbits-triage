import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { PR_TRIAGE_WORKFLOW_VERSION } from "@corbits/triage-contracts";
import type { PrFacts } from "../logic/checks.js";
import type { Item } from "../logic/item.js";
import { degradedVerdict, parseAnswers, renderVerdict, summarize, toMirrorRequest, type BacklogSummary, type Verdict } from "../logic/render.js";

interface EvaluateInput {
  items: Item[];
  batch: boolean;
}

export type EvaluateOutput = Verdict | { items: Verdict[]; summary: BacklogSummary };

// Items are unchecked so a malformed one degrades its own verdict instead of failing the batch.
const Input = type({ items: "object[]", batch: "boolean" });

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** A facts failure or malformed input reaches the render step without facts: the verdict then names no head and is degraded. */
function stamp(facts: PrFacts | undefined) {
  return { repo: facts?.repo ?? "", number: facts?.number ?? 0, headSha: facts?.headSha ?? null, workflowVersion: PR_TRIAGE_WORKFLOW_VERSION };
}

function verdictOf(it: Item): Verdict {
  if (it.error !== undefined) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(it.error), cleanupMode: it.cleanupMode };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
  try {
    const answers = it.judge !== undefined ? parseAnswers(it.judge) : null;
    const verdict = { ...stamp(it.facts), ...renderVerdict({ author: it.facts.author, det: it.det, answers, judgeError: it.judgeError, reviewers: it.facts.reviewers }), cleanupMode: it.cleanupMode };
    return { ...verdict, request: toMirrorRequest(verdict) };
  } catch (e) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(`render failed: ${errorText(e)}`), cleanupMode: it.cleanupMode };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
}

export async function evaluate(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<EvaluateOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`evaluate: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as EvaluateInput;
  const verdicts = items.map(verdictOf);
  return batch ? { items: verdicts, summary: summarize(verdicts) } : verdicts[0]!;
}
