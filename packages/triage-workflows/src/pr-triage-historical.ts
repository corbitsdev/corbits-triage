// SPDX-License-Identifier: GPL-2.0-only
import { defineWorkflow, onTrigger, step } from "@intx/workflow";
import { credentialBindings, grantRequirements, factsAgent, judgeAgent, mirrorAgent, renderAgent } from "./agents.js";

export const PR_TRIAGE_HISTORICAL_ADDRESS = "pr-triage-historical";

const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: 15 * 60_000 } as const;

// Step outputs are `{ reply, turn }` with the JSON in `reply`, and selectors cannot reach into it, so `map` has no array
// to fan out over. Each director step handles the whole PR list instead: facts lists and fetches, judge asks Jev per
// PR that needs it, render and mirror run per item.
function replyOf(id: string) {
  return { project: { from: `steps.${id}.output` }, fields: ["reply"] } as const;
}

const perBacklog = defineWorkflow({
  id: "pr-triage-historical-run",
  trigger: { type: "manual" },
  steps: {
    facts: step({ agent: factsAgent, input: { from: "trigger.payload" }, ...STEP }),
    judge: step({ agent: judgeAgent, input: replyOf("facts"), after: ["facts"], ...STEP }),
    render: step({ agent: renderAgent, input: replyOf("judge"), after: ["judge"], ...STEP }),
    mirror: step({ agent: mirrorAgent, input: replyOf("render"), after: ["render"], ...STEP }),
  },
});

export const workflow = defineWorkflow({
  id: PR_TRIAGE_HISTORICAL_ADDRESS,
  credentialBindings,
  grantRequirements,
  steps: {
    events: onTrigger({ on: { type: "mail", to: PR_TRIAGE_HISTORICAL_ADDRESS }, body: perBacklog, onBodyFailure: "tolerate" }),
  },
});
