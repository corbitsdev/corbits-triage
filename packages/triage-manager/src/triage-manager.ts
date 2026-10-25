import { action, defineWorkflow, gate, onTrigger, SELF_RUN_RESOURCE, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE, TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { credentialBindingsFor, type Sources } from "@corbits/triage-workflows/agents";
import { triageSteps } from "@corbits/triage-workflows/triage-steps";
import { HUB_WRITE } from "./actions/manager.js";

const TRIAGE_MANAGER_ADDRESS = "triage-manager";

/** Done reads whether take found the run refused, besides the mail. */
const TAKEN = { merge: [{ project: { from: "trigger" }, fields: ["payload"] }, { project: { from: "steps" }, fields: ["take"] }] } as const;

function hubAction(handler: "take" | "done", input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/**
 * A pull request's manager under `id`, also its mail address, for the given hosts. Each hub mail runs one body: take the
 * pending events, run stage 1 as pr-triage's own steps over the mail when there are any, then done; the run stops itself
 * when done ends its claim. Rules that need the judge post nothing yet. It binds only the hosts' facts and mirror, the
 * host actions it runs.
 */
export function triageManager({ id = TRIAGE_MANAGER_ADDRESS, sources }: { id?: string; sources: Sources }) {
  const { facts, rules, evaluateRules, mirrorRules } = triageSteps(sources);
  const perMail = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      take: hubAction("take", { from: "trigger.payload" }, []),
      taken: gate({ when: { from: "steps.take.output.taken" }, then: "facts", else: "done", after: ["take"] }),
      facts: { ...facts, after: ["taken"] },
      rules,
      route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "done", else: "evaluateRules", after: ["rules"] }),
      evaluateRules,
      mirrorRules,
      done: hubAction("done", TAKEN, ["taken", "route", "mirrorRules"]),
    },
  });
  return defineWorkflow({
    id,
    credentialBindings: credentialBindingsFor(sources).filter((binding) => binding.action !== "execute"),
    grantRequirements: [
      { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION, source: "creator" },
      { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
    ],
    mailAccept: TRIAGE_MAIL_ACCEPT,
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}

/** The library definition the tests run; the deployed packages are its per-host builds. */
export const workflow = triageManager({ sources: ["github"] });
