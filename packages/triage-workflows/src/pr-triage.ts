import { defineWorkflow, onTrigger } from "@intx/workflow";
import { credentialBindings, grantRequirements } from "./agents.js";
import { triageSteps } from "./triage-steps.js";

export type { CheckResult } from "./logic/checks.js";

export const PR_TRIAGE_ADDRESS = "pr-triage";

const perPr = defineWorkflow({
  id: "pr-triage-run",
  trigger: { type: "manual" },
  steps: triageSteps(),
});

export const workflow = defineWorkflow({
  id: "pr-triage",
  credentialBindings,
  grantRequirements,
  steps: {
    events: onTrigger({ on: { type: "mail", to: PR_TRIAGE_ADDRESS }, body: perPr, onBodyFailure: "tolerate" }),
  },
});
