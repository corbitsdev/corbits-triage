import { defineAgent } from "@intx/agent";
import { bitbucketRead, bitbucketWrite } from "@corbits/bitbucket-datacenter-tool";
import { githubRead, githubWrite } from "@corbits/github-tool";
import { triageDirector } from "./directors.js";
import { JUDGE_SYSTEM_PROMPT } from "./logic/quality.js";

// Required by AgentDefinition. System One is the only inference, and only the judge director ever infers.
// "decision" is a tenant catalog alias; the offering behind it picks the provider and wire model.
const inference = { sources: [{ provider: "corbits-system-one", model: "decision" }] };

// Source-ref lineage keys the credential consumer on the tool bundle id (factory.id), not the published package name.
const GITHUB_CONSUMERS = [githubRead.id, githubWrite.id];
const BITBUCKET_CONSUMERS = [bitbucketRead.id, bitbucketWrite.id];
const CONSUMERS = [...GITHUB_CONSUMERS, ...BITBUCKET_CONSUMERS];

// Verified against interchange (packages/authz, workflow-deploy, hub-api, docs/AUTH.md, CREDENTIALS.md):
// - Resource grammar is `type:identifier` with globs; tool gates are `tool:<bundleId>:<toolName>` with action `invoke`.
// - `credential:{id}` / `use` is NOT a grantRequirement: GrantRequirement.source is only creator|invoker, and tenant-owned
//   credential use is authorized by ownership. Each credentialBinding makes the launch stamp a system-origin
//   `credential:{id}` / `use` grant scoped by `{ tool: "tool:<packageName>" }` (toolConsumer, package granularity).
//   Requirement authors cannot know the credential id, so the narrowest form is the per-package binding, not a requirement.
// - Because the consumer identity is the package name, read and write need separate packages to get separate credential grants.
// - `conditions.tool` is only evaluated on the credential-use path (CREDENTIAL_USE_CONDITIONS); on `tool:` requirements it is
//   not a bundle scoper, so tool requirements are scoped by the bundle id in the resource itself.
function credentialBinding(pkg: string, credential: "github" | "bitbucket-datacenter") {
  return {
    package: pkg,
    handle: credential,
    provider: credential,
    name: credential,
    locator: "tenant",
  } as const;
}

export const credentialBindings = [
  ...GITHUB_CONSUMERS.map((pkg) => credentialBinding(pkg, "github")),
  ...BITBUCKET_CONSUMERS.map((pkg) => credentialBinding(pkg, "bitbucket-datacenter")),
];

// This hub does not stamp credential-use grants from bindings (verified: runs/<id>/grants.json had none and the tool failed
// closed), so each package gets an explicit creator-sourced `credential:*` / `use` requirement scoped by `{ tool }`.
function credentialGrant(pkg: string) {
  return {
    resource: "credential:*",
    action: "use",
    source: "creator",
    conditions: { tool: `tool:${pkg}` },
  } as const;
}

export const grantRequirements = [
  ...CONSUMERS.map(credentialGrant),
  { resource: `tool:${githubRead.id}:*`, action: "invoke", source: "creator" },
  { resource: `tool:${githubWrite.id}:github_mirror_auto`, action: "invoke", source: "creator" },
  { resource: `tool:${githubWrite.id}:github_execute_do_auto`, action: "invoke", source: "creator" },
  { resource: `tool:${bitbucketRead.id}:*`, action: "invoke", source: "creator" },
  { resource: `tool:${bitbucketWrite.id}:bitbucket_datacenter_mirror_auto`, action: "invoke", source: "creator" },
  { resource: `tool:${bitbucketWrite.id}:bitbucket_datacenter_execute_action_auto`, action: "invoke", source: "creator" },
] as const;

export const factsAgent = defineAgent({
  id: "triage-facts",
  systemPrompt: "Deterministic fact gathering from the pull request's host. No inference.",
  tools: [githubRead, bitbucketRead],
  capabilities: [],
  inference,
  director: triageDirector.build({ role: "facts" }),
});

// System One answers the offering's configured questions over the input as evaluation state; the portal deploys onto
// the tenant's corbits-system-one offerings (apps/web/src/lib/workflow-deploy.ts). The workflow maps it over the rules
// output's chunks, and its director makes one System One call per chunk.
export const judgeAgent = defineAgent({
  id: "triage-judge",
  systemPrompt: JUDGE_SYSTEM_PROMPT,
  tools: [],
  capabilities: [],
  inference,
  director: triageDirector.build({ role: "judge" }),
});

export const executeAgent = defineAgent({
  id: "triage-execute",
  systemPrompt: "Deterministic execution of unattended policy actions. No inference.",
  tools: [githubWrite, bitbucketWrite],
  capabilities: [],
  inference,
  director: triageDirector.build({ role: "execute" }),
});

export const mirrorAgent = defineAgent({
  id: "triage-mirror",
  systemPrompt: "Deterministic mirror onto the pull request's host. No inference.",
  tools: [githubWrite, bitbucketWrite],
  capabilities: [],
  inference,
  director: triageDirector.build({ role: "mirror" }),
});
