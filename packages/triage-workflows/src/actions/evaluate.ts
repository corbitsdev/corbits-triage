import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { PR_TRIAGE_WORKFLOW_VERSION } from "@corbits/triage-contracts";
import { evaluateActions } from "../logic/actions.js";
import { extractChangeCandidates } from "../logic/candidates.js";
import type { PrFacts } from "../logic/checks.js";
import { errorText } from "../logic/extract.js";
import type { Item } from "../logic/item.js";
import { degradedVerdict, parseAnswers, renderVerdict, summarize, toMirrorRequest, type BacklogSummary, type Verdict } from "../logic/render.js";
import { stepJson } from "../logic/step-json.js";

/** The rules output, merged with the judge step's `reply` when the judge ran. */
interface EvaluateInput {
  items: Item[];
  batch: boolean;
  reply?: unknown;
}

/** The judge's answer for one item, in item order; empty for an item it did not ask about. */
export type Judgment = Pick<Item, "judge" | "judgeError">;

export type EvaluateOutput = Verdict | { items: Verdict[]; summary: BacklogSummary };

// Items are unchecked so a malformed one degrades its own verdict instead of failing the batch.
const Input = type({ items: "object[]", batch: "boolean", "reply?": "unknown" });

/** A facts failure or malformed input reaches this step without facts: the verdict then names no head and is degraded. */
function stamp(facts: PrFacts | undefined) {
  return { repo: facts?.repo ?? "", number: facts?.number ?? 0, headSha: facts?.headSha ?? null, workflowVersion: PR_TRIAGE_WORKFLOW_VERSION };
}

function verdictOf(it: Item): Verdict {
  if (it.error !== undefined) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(it.error), cleanupMode: it.cleanupMode, actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
  try {
    const answers = it.judge !== undefined ? parseAnswers(it.judge) : null;
    const candidates = extractChangeCandidates(it.facts.files);
    const rendered = renderVerdict({ author: it.facts.author, det: it.det, answers, candidates, judgeError: it.judgeError, reviewers: it.facts.reviewers });
    // A degraded verdict is incomplete, so nothing is suggested from it.
    const actions = it.pack && rendered.degraded === null ? evaluateActions({ facts: it.facts, checks: rendered.checks, pack: it.pack, roles: it.roles ?? {} }) : [];
    const verdict = { ...stamp(it.facts), ...rendered, cleanupMode: it.cleanupMode, actions };
    return { ...verdict, request: toMirrorRequest(verdict) };
  } catch (e) {
    const verdict = { ...stamp(undefined), ...degradedVerdict(`render failed: ${errorText(e)}`), cleanupMode: it.cleanupMode, actions: [] };
    return { ...verdict, request: toMirrorRequest(verdict) };
  }
}

function judgmentsOf(input: unknown): Judgment[] {
  const answers = stepJson(input)?.answers;
  return Array.isArray(answers) ? (answers as Judgment[]) : [];
}

export async function evaluate(input: unknown, _ctx: EffectContext, _signal: AbortSignal): Promise<EvaluateOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`evaluate: invalid input: ${parsed.summary}`);
  const { items, batch } = parsed as EvaluateInput;
  const judgments = judgmentsOf(parsed);
  const verdicts = items.map((it, i) => verdictOf({ ...it, ...judgments[i] }));
  return batch ? { items: verdicts, summary: summarize(verdicts) } : verdicts[0]!;
}
