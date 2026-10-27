import { defineAgent } from "@intx/agent";
import type { RepoSource } from "@corbits/triage-contracts";
import { triageJudgeDirector } from "./directors.js";
import { JUDGE_SYSTEM_PROMPT } from "./logic/quality.js";

// Required by AgentDefinition. "decision" is a tenant catalog alias; the offering behind it picks the provider and wire model.
const inference = { sources: [{ provider: "corbits-system-one", model: "decision" }] };

export type Sources = readonly RepoSource[];

/** The actions that reach the pull request's host; each declares the handle of every host its definition is deployed for. */
const HOST_ACTIONS = ["facts", "mirror", "execute"] as const;

/**
 * Binding resolution fails a deployment closed, so a definition binds only the credentials of the hosts it is deployed
 * for. A host's credential handle is its name. Each binding makes the launch stamp a system-origin `credential:{id}` /
 * `use` grant scoped to `action:<handler>`, so each host action reaches only the credentials bound to it.
 */
export function credentialBindingsFor(sources: Sources) {
  return sources.flatMap(function bindings(source) {
    return HOST_ACTIONS.map((action) => ({ action, handle: source, provider: source, name: source, locator: "tenant" }) as const);
  });
}

export const credentialBindings = credentialBindingsFor(["github"]);

/**
 * System One answers the offering's configured questions over the input as evaluation state; the hub deploys onto
 * the tenant's corbits-system-one offerings (apps/hub/src/workflow-release). The workflow maps it over the rules
 * output's chunks, and its director makes one System One call per chunk.
 */
export const judgeAgent = defineAgent({
  id: "triage-judge",
  systemPrompt: JUDGE_SYSTEM_PROMPT,
  tools: [],
  capabilities: [],
  inference,
  director: triageJudgeDirector.build({}),
});
