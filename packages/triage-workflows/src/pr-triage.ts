import { defineWorkflow, onTrigger } from "@intx/workflow";
import { credentialBindingsFor, type Sources } from "./agents.js";
import { triageSteps } from "./triage-steps.js";

export type { CheckResult } from "./logic/checks.js";

export const PR_TRIAGE_ADDRESS = "pr-triage";

/**
 * The pr-triage definition for the given hosts under `id`, which is also its mail address: the same steps over those
 * hosts' credentials, binding only theirs, because an unresolved binding fails the deployment.
 * The deployed packages are one per host (pr-triage-github, pr-triage-bitbucket-datacenter); the hub mails the one of
 * each pull request's host, and the mail names that host as `repoSource`.
 */
export function prTriage({ id = PR_TRIAGE_ADDRESS, sources }: { id?: string; sources: Sources }) {
  const perPr = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: triageSteps(sources),
  });
  return defineWorkflow({
    id,
    credentialBindings: credentialBindingsFor(sources),
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perPr, onBodyFailure: "tolerate" }),
    },
  });
}

/** The library definition the tests and evals run; the deployed packages are its per-host builds. */
export const workflow = prTriage({ sources: ["github"] });
