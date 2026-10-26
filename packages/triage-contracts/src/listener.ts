import type { RepoSource } from "./repo-source.js";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "./stage-result.js";

/** Each host's listener by its definition id, also its mail address: a workspace with one live routes pull requests to managers. */
export const TRIAGE_LISTENERS: Record<RepoSource, string> = { github: "triage-listener-github", "bitbucket-datacenter": "triage-listener-bitbucket-datacenter" };

/** The system role a person holds to publish the listener's chain and deploy it, which every deployment of it then acts under. */
export const DEPLOYER_ROLE = "Deployer";

/** Publishing and deploying the chain, and every grant the chain's workflows take from their creator. */
export const DEPLOYER_GRANTS: ReadonlyArray<{ resource: string; action: string }> = [
  { resource: "asset:*", action: "create" },
  // Stock gives an asset's creator no grant on it, and a push needs `write`.
  { resource: "asset:*", action: "write" },
  { resource: "workflow:*", action: "create" },
  // The manager and the code review stop their own runs, and an upgrade stops the listeners it replaces.
  { resource: "workflow-run:*", action: "manage" },
  { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION },
  { resource: MANAGER_RESULT_RESOURCE, action: MANAGER_RESULT_ACTION },
];
