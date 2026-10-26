import { defineWorkflow, onTrigger } from "@intx/workflow";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { credentialBindingsFor, type Sources } from "./agents.js";
import { triageSteps } from "./triage-steps.js";

export type { CheckResult } from "./logic/checks.js";

export const PR_TRIAGE_ADDRESS = "pr-triage";

/**
 * The triage steps for the given hosts as one definition under `id`, which is also its mail address, binding only
 * those hosts' credentials; the tests, the evals, the policy check and the extension run it locally.
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
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perPr, onBodyFailure: "tolerate" }),
    },
  });
}

/** The definition on GitHub. */
export const workflow = prTriage({ sources: ["github"] });
