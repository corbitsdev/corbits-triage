import { createSizeCapTransform } from "@intx/inference";
import type { StrategyContext, ToolCall, ToolResult } from "@intx/types/runtime";

const sizeCap = createSizeCapTransform({ maxChars: 10_000, contextStore: { async writeBlob() {} } });

/** `result` of `call` as the director gets it after the stock result assembly. */
export async function assembled(call: ToolCall, result: Omit<ToolResult, "callId">): Promise<ToolResult> {
  return (await sizeCap.apply({ call, result: { callId: call.id, ...result } }, {} as StrategyContext)).output;
}
