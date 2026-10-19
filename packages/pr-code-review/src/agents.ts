import { defineAgent } from "@intx/agent";
import { bitbucketRead } from "@corbits/bitbucket-datacenter-tool";
import { githubRead } from "@corbits/github-tool";
import { repoReadUnder } from "@corbits/repo-read-tool";
import type { RepoSource } from "@corbits/triage-contracts";
import type { CodeReviewDirectors } from "./directors.js";
import type { CodeReviewProfile, Role } from "./profile.js";
import { SYSTEM_PROMPTS } from "./prompts.js";

export type Sources = readonly RepoSource[];

const READS: Record<RepoSource, typeof githubRead> = { github: githubRead, "bitbucket-datacenter": bitbucketRead };

function readsOf(sources: Sources) {
  return sources.map((source) => READS[source]);
}

/**
 * Each host's read bundle and the checkout action bound to the tenant's credential for that host, whose handle is the
 * host's name; an unresolved binding fails the deployment, so only the given hosts are bound.
 */
export function credentialBindingsFor(sources: Sources) {
  return sources.flatMap((source) => [
    { package: READS[source].id, handle: source, provider: source, name: source, locator: "tenant" } as const,
    { action: "checkout", handle: source, provider: source, name: source, locator: "tenant" } as const,
  ]);
}

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["areas", "outside_diff"],
  properties: {
    areas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "why", "what_to_check"],
        properties: { path: { type: "string" }, why: { type: "string" }, what_to_check: { type: "string" } },
      },
    },
    outside_diff: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["symbol_or_path", "why"],
        properties: { symbol_or_path: { type: "string" }, why: { type: "string" } },
      },
    },
  },
};

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "reason"],
  properties: { verdict: { type: "string", enum: ["real", "not_real"] }, reason: { type: "string" } },
};

const CONSOLIDATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["defect", "members", "representative"],
        properties: { defect: { type: "string" }, members: { type: "array", items: { type: "integer" } }, representative: { type: "integer" } },
      },
    },
  },
};

const WRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "comments"],
  properties: {
    summary: { type: "string" },
    comments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["finding", "title", "body"],
        properties: { finding: { type: "integer" }, title: { type: "string" }, body: { type: "string" } },
      },
    },
  },
};

/**
 * The review's agents, each declaring its step's model on the profile's provider and run by the provider's directors;
 * the repository finder reads checkouts under the sidecar data dir `dataDir` names.
 */
export function codeReviewAgents(profile: CodeReviewProfile, { reader, consolidate, structured }: CodeReviewDirectors, dataDir: () => string) {
  function inference(role: Role) {
    return { sources: [{ provider: profile.provider, model: profile.models[role] }] };
  }

  function structuredAgent(id: string, name: "plan" | "check" | "write", schema: Record<string, unknown>) {
    return defineAgent({ id, systemPrompt: SYSTEM_PROMPTS[name], tools: [], capabilities: [], inference: inference(name), director: structured.build({ name, schema }) });
  }

  /** The diff finder: one model turn over the pull request's diff, no tools. */
  function finderAgent(systemPrompt = SYSTEM_PROMPTS["finder-diff"]) {
    return defineAgent({ id: "code-review-finder", systemPrompt, tools: [], capabilities: [], inference: inference("diffFinder") });
  }

  /** The repository finder: the model reads the checkout its input names with the read tools, confined to it. */
  function repoFinderAgent(systemPrompt = SYSTEM_PROMPTS["finder-repo"]) {
    return defineAgent({
      id: "code-review-finder-repo",
      systemPrompt,
      tools: [repoReadUnder(dataDir)],
      capabilities: [],
      inference: inference("repoFinder"),
      director: reader.build({ tools: "finder-repo" }),
    });
  }

  /** Reads the lines each finding cites at the head through the host's contents API, then groups the findings by defect. */
  function consolidateAgent(sources: Sources) {
    return defineAgent({
      id: "code-review-consolidate",
      systemPrompt: SYSTEM_PROMPTS.consolidate,
      tools: readsOf(sources),
      capabilities: [],
      inference: inference("consolidate"),
      director: consolidate.build({ name: "consolidate", schema: CONSOLIDATE_SCHEMA }),
    });
  }

  return {
    finderAgent,
    repoFinderAgent,
    consolidateAgent,
    planAgent: structuredAgent("code-review-plan", "plan", PLAN_SCHEMA),
    checkAgent: structuredAgent("code-review-check", "check", CHECK_SCHEMA),
    writeAgent: structuredAgent("code-review-write", "write", WRITE_SCHEMA),
  };
}

export type CodeReviewAgents = ReturnType<typeof codeReviewAgents>;
