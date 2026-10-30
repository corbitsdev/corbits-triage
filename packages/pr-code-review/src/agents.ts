import { defineAgent } from "@intx/agent";
import { repoReadUnder } from "@corbits/repo-read-tool";
import type { RepoSource } from "@corbits/triage-contracts";
import type { CodeReviewDirectors } from "./directors.js";
import type { CodeReviewProfile, Role } from "./profile.js";
import { SYSTEM_PROMPTS } from "./prompts.js";

export type Sources = readonly RepoSource[];

/** GitHub's review token is contents-read-only; Bitbucket binds its workspace credential. */
const CREDENTIAL: Record<RepoSource, string> = { github: "github-read", "bitbucket-datacenter": "bitbucket-datacenter" };

export function credentialBindingsFor(sources: Sources) {
  return sources.map((source) => ({ action: "checkout", handle: source, provider: source, name: CREDENTIAL[source], locator: "tenant" }) as const);
}

export function codeReviewAgents(profile: CodeReviewProfile, { reader }: CodeReviewDirectors, dataDir: () => string) {
  function inference(role: Role) {
    return { sources: [{ provider: profile.provider, model: profile.models[role] }] };
  }
  function finderAgent(systemPrompt = SYSTEM_PROMPTS["finder-diff"]) {
    return defineAgent({ id: "code-review-finder", systemPrompt, tools: [repoReadUnder(dataDir)], capabilities: [], inference: inference("diffFinder"), director: reader.build({ tools: "diff", answer: "findings" }) });
  }
  return {
    finderAgent,
    checkAgent: defineAgent({
      id: "code-review-check",
      systemPrompt: SYSTEM_PROMPTS.check,
      tools: [repoReadUnder(dataDir)],
      capabilities: [],
      inference: inference("check"),
      director: reader.build({ tools: "check", answer: "verdict" }),
    }),
  };
}
export type CodeReviewAgents = ReturnType<typeof codeReviewAgents>;
