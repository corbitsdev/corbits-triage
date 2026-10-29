import type { EffectContext, PerformScope } from "@intx/workflow";
import type { ToolResult } from "@intx/types/runtime";
import { type } from "arktype";
import { repoSourceOf, ThreadRead } from "@corbits/triage-contracts";
import { call, hostCalls, READ_PULL_REQUEST, toolName } from "@corbits/triage-workflows/logic/host";
import { managerMailOf } from "./hub.js";
import { TakeOutput } from "./manager.js";

const ThreadsInput = type({ payload: "unknown", take: { output: TakeOutput } });
const Read = type({ threads: ThreadRead.array(), "unread?": "string" });

/**
 * Reads what became of the threads of the findings posted on earlier heads, which take names on a pass for a newer
 * head, once for each head. A read the host refuses, whole or for some threads, leaves those findings as they were last
 * read, and says why for the hub to log.
 */
export async function findingThreads(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ reads: ThreadRead[]; unread?: string }> {
  const parsed = ThreadsInput(input);
  if (parsed instanceof type.errors) throw new Error(`findingThreads: ${parsed.summary}`);
  const { head, threads } = parsed.take.output;
  if (head === undefined || threads === undefined) return { reads: [] };
  const { pullRequest } = managerMailOf(parsed.payload);
  const source = repoSourceOf(pullRequest.source);
  const asked = call(toolName(source, "finding_thread_states"), { repo: pullRequest.repo, number: pullRequest.number, ids: threads }, `threads:${head}`);
  function run({ credentials }: PerformScope) {
    return hostCalls(source, credentials)(asked);
  }
  const result = await ctx.perform({ effectId: asked.id, capability: READ_PULL_REQUEST, run }) as ToolResult;
  if (result.isError) return { reads: [], unread: JSON.stringify(result.content) };
  const { threads: reads, unread } = Read.assert(result.content);
  return { reads, ...(unread !== undefined && { unread }) };
}
