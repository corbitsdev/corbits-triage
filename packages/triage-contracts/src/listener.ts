import type { RepoSource } from "./repo-source.js";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "./stage-result.js";

/** Each host's listener by its definition id, also its mail address: a workspace with one live routes pull requests to managers. */
export const TRIAGE_LISTENERS: Record<RepoSource, string> = { github: "triage-listener-github", "bitbucket-datacenter": "triage-listener-bitbucket-datacenter" };

/** Each host's pull request manager by its definition id, also its mail address. */
export const TRIAGE_MANAGERS: Record<RepoSource, string> = { github: "triage-manager-github", "bitbucket-datacenter": "triage-manager-bitbucket-datacenter" };

/** The system role the hub's publisher holds to publish the listener's chain and deploy it, which every deployment of it then acts under. */
export const DEPLOYER_ROLE = "Deployer";

/** Deploying the chain, and every grant the chain's workflows take from their creator. */
export const DEPLOYER_GRANTS: ReadonlyArray<{ resource: string; action: string }> = [
  { resource: "workflow:*", action: "create" },
  // The manager and the code review stop their own runs.
  { resource: "workflow-run:*", action: "manage" },
  // The listener and the manager read the run they just deployed before mailing it; manage does not satisfy read.
  { resource: "workflow-run:*", action: "read" },
  { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION },
  { resource: MANAGER_RESULT_RESOURCE, action: MANAGER_RESULT_ACTION },
];
