import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { execute, type DoResult } from "@corbits/triage-workflows/actions/execute";

/** The handler of the PR workflow's execute step; an approval mail still runs triage's own `execute`. */
export const EXECUTE_DECIDED = "executeDecided";

const Input = type({ verdict: "object", held: "object[]" });

type Held = { effectId: string; status: "held"; error: string };

/**
 * `held` names a Do left for a maintainer after the run: the hub reads it as a Do triage held itself, which waits in
 * Needs you for an approval mail.
 */
type ExecuteDecidedOutput = { dos: Array<DoResult | Held>; reason?: string };

/** Triage's execute on the Dos `decide` made; it fails, and writes nothing, without a decision. */
export async function executeDecided(input: unknown, ctx: EffectContext, signal: AbortSignal): Promise<ExecuteDecidedOutput> {
  const parsed = Input(input);
  if (parsed instanceof type.errors) throw new Error(`executeDecided: invalid input: ${parsed.summary}`);
  const executed = await execute(parsed.verdict, ctx, signal);
  return { ...executed, dos: [...executed.dos, ...(parsed.held as Held[])] };
}
