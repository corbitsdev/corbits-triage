import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { approval, execute } from "@corbits/triage-workflows/actions/index";
import { TakeOutput } from "./manager.js";

const ApprovalsInput = type({ take: { output: TakeOutput } });

/**
 * Runs each held Do approved since the last pass as pr-triage runs an approval mail: the approval is read, then
 * executed, which skips a Do whose pull request has moved past the head it was held on.
 */
export async function executeApprovals(input: unknown, ctx: EffectContext, signal: AbortSignal): Promise<{ results: unknown[] }> {
  const parsed = ApprovalsInput(input);
  if (parsed instanceof type.errors) throw new Error(`executeApprovals: ${parsed.summary}`);
  const results: unknown[] = [];
  for (const request of parsed.take.output.approvals) {
    results.push(await execute(await approval({ taken: request }, ctx, signal), ctx, signal));
  }
  return { results };
}
