import { defineAgent } from "@intx/agent";
import { bitbucketRead, bitbucketWrite } from "@corbits/bitbucket-datacenter-tool";
import { githubRead, githubWrite } from "@corbits/github-tool";
import type { RepoSource } from "@corbits/triage-contracts";
import { triageDirector } from "./directors.js";
import { JUDGE_SYSTEM_PROMPT } from "./logic/quality.js";

// Required by AgentDefinition. System One is the only inference, and only the judge director ever infers.
// "decision" is a tenant catalog alias; the offering behind it picks the provider and wire model.
const inference = { sources: [{ provider: "corbits-system-one", model: "decision" }] };

// Source-ref lineage keys the credential consumer on the tool bundle id (factory.id), not the published package name.
type Bundles = { read: typeof githubRead; write: typeof githubWrite; credential: RepoSource };

const BUNDLES: Record<RepoSource, Bundles> = {
  github: { read: githubRead, write: githubWrite, credential: "github" },
  "bitbucket-datacenter": { read: bitbucketRead, write: bitbucketWrite, credential: "bitbucket-datacenter" },
};

// Verified against interchange (packages/authz, workflow-deploy, hub-api, docs/AUTH.md, CREDENTIALS.md):
// - Resource grammar is `type:identifier` with globs; tool gates are `tool:<bundleId>:<toolName>` with action `invoke`.
// - `credential:{id}` / `use` is NOT a grantRequirement: GrantRequirement.source is only creator|invoker, and tenant-owned
//   credential use is authorized by ownership. Each credentialBinding makes the launch stamp a system-origin
//   `credential:{id}` / `use` grant scoped by `{ tool: "tool:<packageName>" }` (toolConsumer, package granularity).
//   Requirement authors cannot know the credential id, so the narrowest form is the per-package binding, not a requirement.
// - Because the consumer identity is the package name, read and write need separate packages to get separate credential grants.
function credentialBinding(pkg: string, credential: RepoSource) {
  return {
    package: pkg,
    handle: credential,
    provider: credential,
    name: credential,
    locator: "tenant",
  } as const;
}

export type Sources = readonly RepoSource[];

const GITHUB: Sources = ["github"];

/** Binding resolution fails a deployment closed, so a definition binds only the credentials of the hosts it is deployed for. */
export function credentialBindingsFor(sources: Sources) {
  return sources.flatMap(function bindings(source) {
    const { read, write, credential } = BUNDLES[source];
    return [read.id, write.id].map((pkg) => credentialBinding(pkg, credential));
  });
}

export const credentialBindings = credentialBindingsFor(GITHUB);

export type TriageAgents = ReturnType<typeof triageAgents>;

/** The four agents over the tool bundles of the given hosts; the directors pick a host's tools by the mail's repository source. */
export function triageAgents(sources: Sources) {
  const read = sources.map((source) => BUNDLES[source].read);
  const write = sources.map((source) => BUNDLES[source].write);
  return {
    facts: defineAgent({
      id: "triage-facts",
      systemPrompt: "Deterministic fact gathering from the pull request's host. No inference.",
      tools: read,
      capabilities: [],
      inference,
      director: triageDirector.build({ role: "facts" }),
    }),
    // System One answers the offering's configured questions over the input as evaluation state; the portal deploys onto
    // the tenant's corbits-system-one offerings (apps/web/src/lib/workflow-deploy.ts). The workflow maps it over the rules
    // output's chunks, and its director makes one System One call per chunk.
    judge: defineAgent({
      id: "triage-judge",
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      tools: [],
      capabilities: [],
      inference,
      director: triageDirector.build({ role: "judge" }),
    }),
    execute: defineAgent({
      id: "triage-execute",
      systemPrompt: "Deterministic execution of unattended policy actions. No inference.",
      tools: write,
      capabilities: [],
      inference,
      director: triageDirector.build({ role: "execute" }),
    }),
    mirror: defineAgent({
      id: "triage-mirror",
      systemPrompt: "Deterministic mirror onto the pull request's host. No inference.",
      tools: write,
      capabilities: [],
      inference,
      director: triageDirector.build({ role: "mirror" }),
    }),
  };
}
