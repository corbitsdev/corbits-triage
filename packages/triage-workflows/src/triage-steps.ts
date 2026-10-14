import { action, gate, map, step } from "@intx/workflow";
import { executeAgent, factsAgent, judgeAgent, mirrorAgent } from "./agents.js";

// Transient failures must not fail the body; the section also tolerates a failed body and re-arms for the next mail.
const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: 15 * 60_000 } as const;

function outputOf(id: string) {
  return { from: `steps.${id}.output` } as const;
}

function replyOf(id: string) {
  return { project: outputOf(id), fields: ["reply"] } as const;
}

/** A map's output is an array, which a merge cannot take, so it rides as `judge.output`. */
const JUDGED = { project: { from: "steps" }, fields: ["judge"] } as const;

const BOTH_JUDGED = { project: { from: "steps" }, fields: ["judge", "judgeParts"] } as const;

/** The chunks are already in the run log twice, as the map's input and each judge call's; evaluate re-derives them. */
const RULED = { project: outputOf("rules"), fields: ["items", "batch"] } as const;

// Actions cannot reach a bound credential on this Interchange pin, so the deterministic facts, execute and mirror steps run
// as directors, reaching GitHub through the tool's credential, until upstream exposes credentials to actions. The judge maps over the
// rules output's chunks, one System One call each; a second map asks focused's file questions only for the items it failed,
// and makes no call otherwise. An approval mail skips triage and executes the one held Do it names. Each gate branch evaluates, executes and mirrors on its own: a live run never
// hands a skipped step's output to a selector, so a join after the gate could not read the judge when it was skipped.
export function triageSteps() {
  return {
    approval: action({ handler: "approval", input: { from: "trigger.payload" } }),
    approved: gate({ when: { from: "steps.approval.output.approved" }, then: "executeApproved", else: "facts", after: ["approval"] }),
    executeApproved: step({ agent: executeAgent, input: outputOf("approval"), after: ["approved"], ...STEP }),
    facts: step({ agent: factsAgent, input: { from: "trigger.payload" }, after: ["approved"], ...STEP }),
    rules: action({ handler: "rules", input: replyOf("facts"), after: ["facts"] }),
    route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "judge", else: "evaluateRules", after: ["rules"] }),
    judge: map({ over: { from: "steps.rules.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["route"] }),
    parts: action({ handler: "parts", input: { merge: [RULED, JUDGED] }, after: ["judge"] }),
    judgeParts: map({ over: { from: "steps.parts.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["parts"] }),
    evaluate: action({ handler: "evaluate", input: { merge: [RULED, BOTH_JUDGED] }, after: ["judgeParts"] }),
    execute: step({ agent: executeAgent, input: outputOf("evaluate"), after: ["evaluate"], ...STEP }),
    mirror: step({ agent: mirrorAgent, input: outputOf("evaluate"), after: ["execute"], ...STEP }),
    evaluateRules: action({ handler: "evaluate", input: outputOf("rules"), after: ["route"] }),
    executeRules: step({ agent: executeAgent, input: outputOf("evaluateRules"), after: ["evaluateRules"], ...STEP }),
    mirrorRules: step({ agent: mirrorAgent, input: outputOf("evaluateRules"), after: ["executeRules"], ...STEP }),
  };
}
