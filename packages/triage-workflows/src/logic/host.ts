import { bitbucketCalls } from "@corbits/bitbucket-datacenter-tool/calls";
import { isRecord } from "@corbits/common";
import { githubCalls } from "@corbits/github-tool/calls";
import type { RepoSource } from "@corbits/triage-contracts";
import type { EffectContext, PerformScope } from "@intx/workflow";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

/** The effect capabilities the host actions declare: facts reads the pull request, mirror and execute write to it. */
export const READ_PULL_REQUEST = "pull-request.read";
export const WRITE_PULL_REQUEST = "pull-request.write";

/** One host call, by the host tool's name; a failure comes back as an error result, as it does to an agent. */
export type HostCall = (call: ToolCall) => Promise<ToolResult>;

/** One host write, recorded under its effect id: the call id. */
export type HostWrite = (source: RepoSource, call: ToolCall) => Promise<ToolResult>;

/** Each host's tool names are prefixed with it; the GitHub ones are the original names. */
const TOOL_PREFIX: Record<RepoSource, string> = { github: "github_", "bitbucket-datacenter": "bitbucket_datacenter_" };

export function toolName(source: RepoSource, name: string): string {
  return `${TOOL_PREFIX[source]}${name}`;
}

export function call(name: string, args: Record<string, unknown>, id = name): ToolCall {
  return { id, name, arguments: args };
}

const CALLS = { github: githubCalls, "bitbucket-datacenter": bitbucketCalls } as const;

/** The host's calls over the credential its handle, which is the host's name, resolves to. */
export function hostCalls(source: RepoSource, credentials: PerformScope["credentials"]): HostCall {
  async function hostFetch() {
    const mediated = await credentials.resolve(source);
    if (mediated.kind !== "http") throw new Error(`${source} credential must be http, got ${mediated.kind}`);
    return function fetchHost(path: string, init?: RequestInit) {
      return mediated.fetch(path, init);
    };
  }
  return CALLS[source](hostFetch) as HostCall;
}

export function data<T>(r: ToolResult | undefined): T | null {
  return r && !r.isError && isRecord(r.content) ? (r.content as T) : null;
}

/** Runs calls at once and keys each result by its call id. */
export async function runAll(host: HostCall, calls: readonly ToolCall[]): Promise<Map<string, ToolResult>> {
  const results = await Promise.all(calls.map(host));
  return new Map(results.map((result) => [result.callId, result]));
}

/** Each write is its own effect under the call id, so a resumed run does not write it again. */
export function hostWrite(ctx: EffectContext): HostWrite {
  return async function write(source, written) {
    function run({ credentials }: PerformScope) {
      return hostCalls(source, credentials)(written);
    }
    return await ctx.perform({ effectId: written.id, capability: WRITE_PULL_REQUEST, run }) as ToolResult;
  };
}
