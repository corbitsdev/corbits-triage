// SPDX-License-Identifier: GPL-2.0-only
import { defineWorkflow, onTrigger, step } from "@intx/workflow";
import { credentialBindings, grantRequirements, factsAgent, judgeAgent, mirrorAgent, renderAgent } from "./agents.js";

// Transient failures must not fail the body; the section also tolerates a failed body and re-arms for the next mail.
const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: 15 * 60_000 } as const;

export const PR_TRIAGE_ADDRESS = "pr-triage";

// Each step's output is `{ reply, turn }`; the JSON travels in `reply`, so downstream steps project it whole.
function replyOf(id: string) {
  return { project: { from: `steps.${id}.output` }, fields: ["reply"] } as const;
}

const perPr = defineWorkflow({
  id: "pr-triage-run",
  trigger: { type: "manual" },
  steps: {
    facts: step({ agent: factsAgent, input: { from: "trigger.payload" }, ...STEP }),
    judge: step({ agent: judgeAgent, input: replyOf("facts"), after: ["facts"], ...STEP }),
    render: step({ agent: renderAgent, input: replyOf("judge"), after: ["judge"], ...STEP }),
    mirror: step({ agent: mirrorAgent, input: replyOf("render"), after: ["render"], ...STEP }),
  },
});

export const workflow = defineWorkflow({
  id: "pr-triage",
  credentialBindings,
  grantRequirements,
  steps: {
    events: onTrigger({ on: { type: "mail", to: PR_TRIAGE_ADDRESS }, body: perPr, onBodyFailure: "tolerate" }),
  },
});
