import { action, defineWorkflow, onTrigger } from "@intx/workflow";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { credentialBindings } from "./agents.js";
import { hostAction } from "./triage-steps.js";

export const REPO_SCAN_ADDRESS = "repo-scan";

/** Reads a repository's last closed pull requests with pr-triage's facts action and measures what maintainers merged. */
function scanSteps() {
  return {
    history: hostAction("facts", ["github"], { from: "trigger.payload" }, []),
    measure: action({ handler: "measure", input: { from: "steps.history.output" }, after: ["history"] }),
  };
}

const perScan = defineWorkflow({
  id: "repo-scan-run",
  trigger: { type: "manual" },
  steps: scanSteps(),
});

export const workflow = defineWorkflow({
  id: REPO_SCAN_ADDRESS,
  credentialBindings: credentialBindings.filter((binding) => binding.action === "facts"),
  mailAccept: TRIAGE_MAIL_ACCEPT,
  steps: {
    events: onTrigger({ on: { type: "mail", to: REPO_SCAN_ADDRESS }, body: perScan, onBodyFailure: "tolerate" }),
  },
});
