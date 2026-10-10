import { defineWorkflow, onTrigger } from "@intx/workflow";
import { credentialBindings, grantRequirements } from "./agents.js";
import { triageSteps } from "./triage-steps.js";

export const PR_TRIAGE_HISTORICAL_ADDRESS = "pr-triage-historical";

// Each step handles the whole PR list rather than a `map` per PR: facts lists and fetches, rules and evaluate run per
// item, judge asks Jev per PR that needs it, and mirror posts per verdict.
const perBacklog = defineWorkflow({
  id: "pr-triage-historical-run",
  trigger: { type: "manual" },
  steps: triageSteps(),
});

export const workflow = defineWorkflow({
  id: PR_TRIAGE_HISTORICAL_ADDRESS,
  credentialBindings,
  grantRequirements,
  steps: {
    events: onTrigger({ on: { type: "mail", to: PR_TRIAGE_HISTORICAL_ADDRESS }, body: perBacklog, onBodyFailure: "tolerate" }),
  },
});
