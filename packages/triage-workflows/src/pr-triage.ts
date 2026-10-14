import { defineWorkflow, onTrigger } from "@intx/workflow";
import { credentialBindingsFor, grantRequirementsFor, triageAgents, type Sources } from "./agents.js";
import { triageSteps } from "./triage-steps.js";

export type { CheckResult } from "./logic/checks.js";

export const PR_TRIAGE_ADDRESS = "pr-triage";

/**
 * The pr-triage definition for the given hosts: the same steps and directors over those hosts' tool bundles, binding
 * only their credentials, because an unresolved binding fails the deployment. The hub deploys the entry for the hosts a
 * workspace connected; the mail names each pull request's host as `repoSource`.
 */
export function prTriage({ sources }: { sources: Sources }) {
  const perPr = defineWorkflow({
    id: "pr-triage-run",
    trigger: { type: "manual" },
    steps: triageSteps(triageAgents(sources)),
  });
  return defineWorkflow({
    id: PR_TRIAGE_ADDRESS,
    credentialBindings: credentialBindingsFor(sources),
    grantRequirements: grantRequirementsFor(sources),
    steps: {
      events: onTrigger({ on: { type: "mail", to: PR_TRIAGE_ADDRESS }, body: perPr, onBodyFailure: "tolerate" }),
    },
  });
}

export const workflow = prTriage({ sources: ["github"] });
