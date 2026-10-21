import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { execute, type DoResult } from "@corbits/triage-workflows/actions/execute";
import type { SuggestedAction } from "@corbits/triage-workflows/logic/actions";
import type { Verdict } from "@corbits/triage-workflows/logic/render";

/** The handler of the PR workflow's execute step; an approval mail still runs triage's own `execute`. */
export const EXECUTE_AFTER_REVIEW = "executeAfterReview";

/** The review outcomes approve and merge may run after; any other leaves them to a maintainer. */
const REVIEWED = new Set(["clean", "skipped"]);
const AFTER_REVIEW = new Set(["approve", "merge"]);

const Input = type({ outcome: "string", verdict: "object" });

/**
 * `held` names a Do left for a maintainer after the run: the hub reads it as a Do triage held itself, which waits in
 * Needs you for an approval mail.
 */
type ExecuteAfterReviewOutput = { dos: Array<DoResult | { effectId: string; status: "held"; error: string }>; reason?: string };

function waitsOnReview(verdict: Verdict) {
  return function waits(action: SuggestedAction): boolean {
    return AFTER_REVIEW.has(action.kind) && verdict.automatic.includes(action.kind) && !("skipped" in action) && action.held !== true;
  };
}

/**
 * Triage's execute on the verdict code review's outcome carries, so it fails, and writes nothing, when there is no
 * outcome. Until `decide`, approve and merge run only after a clean or skipped review; otherwise each waits for a
 * maintainer and every other Do runs as triage decided.
 */
export async function executeAfterReview(input: unknown, ctx: EffectContext, signal: AbortSignal): Promise<ExecuteAfterReviewOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`executeAfterReview: invalid input: ${parsed.summary}`);
  const { outcome } = parsed;
  const verdict = parsed.verdict as Verdict;
  if (REVIEWED.has(outcome)) return execute(verdict, ctx, signal);
  const waiting = verdict.actions.filter(waitsOnReview(verdict));
  const left = { ...verdict, actions: verdict.actions.filter((action) => !waiting.includes(action)) };
  const executed = await execute(left, ctx, signal);
  const held = waiting.flatMap((action) => ("effectId" in action ? [{ effectId: action.effectId, status: "held" as const, error: `Code review is ${outcome}; a maintainer decides.` }] : []));
  return { ...executed, dos: [...executed.dos, ...held] };
}
