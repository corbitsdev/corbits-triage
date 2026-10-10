import { action, gate, step } from "@intx/workflow";
import { factsAgent, judgeAgent, mirrorAgent } from "./agents.js";

// Transient failures must not fail the body; the section also tolerates a failed body and re-arms for the next mail.
const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: 15 * 60_000 } as const;

function outputOf(id: string) {
  return { from: `steps.${id}.output` } as const;
}

function replyOf(id: string) {
  return { project: outputOf(id), fields: ["reply"] } as const;
}

// facts and mirror stay agent steps because they reach GitHub through the tool credential. Each gate branch evaluates
// and mirrors on its own: a live run never hands a skipped step's output to a selector, so a join after the gate
// could not read the judge when it was skipped.
export function triageSteps() {
  return {
    facts: step({ agent: factsAgent, input: { from: "trigger.payload" }, ...STEP }),
    rules: action({ handler: "rules", input: replyOf("facts"), after: ["facts"] }),
    route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "judge", else: "evaluateRules", after: ["rules"] }),
    judge: step({ agent: judgeAgent, input: outputOf("rules"), after: ["route"], ...STEP }),
    evaluate: action({ handler: "evaluate", input: { merge: [outputOf("rules"), replyOf("judge")] }, after: ["judge"] }),
    mirror: step({ agent: mirrorAgent, input: outputOf("evaluate"), after: ["evaluate"], ...STEP }),
    evaluateRules: action({ handler: "evaluate", input: outputOf("rules"), after: ["route"] }),
    mirrorRules: step({ agent: mirrorAgent, input: outputOf("evaluateRules"), after: ["evaluateRules"], ...STEP }),
  };
}
