import { readFileSync } from "node:fs";
import { defineAgent } from "@intx/agent";
import { bitbucketRead } from "@corbits/bitbucket-datacenter-tool";
import { githubRead } from "@corbits/github-tool";
import { repoRead } from "@corbits/repo-read-tool";
import type { RepoSource } from "@corbits/triage-contracts";
import { reader } from "./reader-director.js";
import { gather } from "./gather-director.js";
import { structured } from "./structured-director.js";

export const DEFAULT_MODEL = "claude-haiku-5-5";

function prompt(name: string): string {
  return readFileSync(new URL(`../prompts/${name}.system.txt`, import.meta.url), "utf8");
}

const inference = { sources: [{ provider: "anthropic", model: DEFAULT_MODEL }] };

export type Sources = readonly RepoSource[];

const READS: Record<RepoSource, typeof githubRead> = { github: githubRead, "bitbucket-datacenter": bitbucketRead };

function readsOf(sources: Sources) {
  return sources.map((source) => READS[source]);
}

/** Each host's read bundle bound to the tenant's credential for that host; an unresolved binding fails the deployment, so only the given hosts are bound. */
export function credentialBindingsFor(sources: Sources) {
  return sources.map((source) => ({ package: READS[source].id, handle: source, provider: source, name: source, locator: "tenant" }) as const);
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

const CONVERGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["defect", "fix", "members", "representative"],
        properties: {
          defect: { type: "string" },
          fix: {
            type: "object",
            additionalProperties: false,
            required: ["path", "line", "edit"],
            properties: { path: { type: "string" }, line: { type: "integer" }, edit: { type: "string" } },
          },
          members: { type: "array", items: { type: "integer" } },
          representative: { type: "integer" },
        },
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

function structuredAgent(id: string, name: string, schema: Record<string, unknown>) {
  return defineAgent({ id, systemPrompt: prompt(name), tools: [], capabilities: [], inference, director: structured.build({ name, schema }) });
}

/** The diff finder: one model turn over the pull request's diff, no tools. */
export function finderAgent(systemPrompt = prompt("finder-diff")) {
  return defineAgent({ id: "code-review-finder", systemPrompt, tools: [], capabilities: [], inference });
}

/** The repository finder: its director checks the head out with the host's read bundle, and the model reads it with the confined read tools. */
export function repoFinderAgent(sources: Sources, systemPrompt = prompt("finder-repo")) {
  return defineAgent({
    id: "code-review-finder-repo",
    systemPrompt,
    tools: [...readsOf(sources), repoRead],
    capabilities: [],
    inference,
    director: reader.build({ tools: "finder-repo" }),
  });
}

export const planAgent = structuredAgent("code-review-plan", "plan", PLAN_SCHEMA);

export const convergeAgent = structuredAgent("code-review-converge", "converge", CONVERGE_SCHEMA);

export const checkAgent = structuredAgent("code-review-check", "check", CHECK_SCHEMA);

export const writeAgent = structuredAgent("code-review-write", "write", WRITE_SCHEMA);

/** No model: reads the files the findings cite at the head, through the host's contents API. */
export function gatherAgent(sources: Sources) {
  return defineAgent({ id: "code-review-gather", systemPrompt: "", tools: readsOf(sources), capabilities: [], inference, director: gather.build({}) });
}
