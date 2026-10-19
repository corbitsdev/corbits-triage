import { action, gate, map, step } from "@intx/workflow";
import { triageAgents, type TriageAgents } from "./agents.js";

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
// and makes no call otherwise. An approval mail skips triage and executes the one held action it names; a waiting mail
// skips triage and mirrors only the waiting marker; any other takes Ready off its head before triaging it. The mirror writes the verdict's comment and label (or build status) before execute,
// so a merge or close finds them on the head it closes; a mirror on a closed pull request would write nothing. Each gate
// branch evaluates, mirrors and executes on its own: a live run never hands a skipped step's output to a selector, so a join
// after the gate could not read the judge when it was skipped.
export function triageSteps({ facts: factsAgent, judge: judgeAgent, execute: executeAgent, mirror: mirrorAgent }: TriageAgents = triageAgents(["github"])) {
  return {
    approval: action({ handler: "approval", input: { from: "trigger.payload" } }),
    approved: gate({ when: { from: "steps.approval.output.approved" }, then: "executeApproved", else: "waiting", after: ["approval"] }),
    executeApproved: step({ agent: executeAgent, input: outputOf("approval"), after: ["approved"], ...STEP }),
    waiting: action({ handler: "waiting", input: { from: "trigger.payload" }, after: ["approved"] }),
    held: gate({ when: { from: "steps.waiting.output.waiting" }, then: "markWaiting", else: "unready", after: ["waiting"] }),
    markWaiting: step({ agent: mirrorAgent, input: outputOf("waiting"), after: ["held"], ...STEP }),
    unready: step({ agent: mirrorAgent, input: outputOf("waiting"), after: ["held"], ...STEP }),
    facts: step({ agent: factsAgent, input: { from: "trigger.payload" }, after: ["unready"], ...STEP }),
    rules: action({ handler: "rules", input: replyOf("facts"), after: ["facts"] }),
    route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "judge", else: "evaluateRules", after: ["rules"] }),
    judge: map({ over: { from: "steps.rules.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["route"] }),
    parts: action({ handler: "parts", input: { merge: [RULED, JUDGED] }, after: ["judge"] }),
    judgeParts: map({ over: { from: "steps.parts.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["parts"] }),
    evaluate: action({ handler: "evaluate", input: { merge: [RULED, BOTH_JUDGED] }, after: ["judgeParts"] }),
    mirror: step({ agent: mirrorAgent, input: outputOf("evaluate"), after: ["evaluate"], ...STEP }),
    execute: step({ agent: executeAgent, input: outputOf("evaluate"), after: ["mirror"], ...STEP }),
    evaluateRules: action({ handler: "evaluate", input: outputOf("rules"), after: ["route"] }),
    mirrorRules: step({ agent: mirrorAgent, input: outputOf("evaluateRules"), after: ["evaluateRules"], ...STEP }),
    executeRules: step({ agent: executeAgent, input: outputOf("evaluateRules"), after: ["mirrorRules"], ...STEP }),
  };
}
