import { action, defineWorkflow, onTrigger, step } from "@intx/workflow";
import { credentialBindings, triageAgents } from "./agents.js";

export const REPO_SCAN_ADDRESS = "repo-scan";

const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: 30 * 60_000 } as const;

/** Reads a repository's last closed pull requests with pr-triage's facts director and measures what maintainers merged. */
function scanSteps({ facts } = triageAgents(["github"])) {
  return {
    history: step({ agent: facts, input: { from: "trigger.payload" }, ...STEP }),
    measure: action({ handler: "measure", input: { project: { from: "steps.history.output" }, fields: ["reply"] }, after: ["history"] }),
  };
}

const perScan = defineWorkflow({
  id: "repo-scan-run",
  trigger: { type: "manual" },
  steps: scanSteps(),
});

export const workflow = defineWorkflow({
  id: REPO_SCAN_ADDRESS,
  credentialBindings,
  steps: {
    events: onTrigger({ on: { type: "mail", to: REPO_SCAN_ADDRESS }, body: perScan, onBodyFailure: "tolerate" }),
  },
});
