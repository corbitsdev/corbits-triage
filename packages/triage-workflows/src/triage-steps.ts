import { action, gate, map, step, type Selector } from "@intx/workflow";
import { judgeAgent, type Sources } from "./agents.js";
import { READ_PULL_REQUEST, WRITE_PULL_REQUEST } from "./logic/host.js";

// Transient failures must not fail the body; the section also tolerates a failed body and re-arms for the next mail.
const TIMEOUT = 15 * 60_000;
const STEP = { retry: { maxAttempts: 3, initialBackoffMs: 5_000, maxBackoffMs: 60_000 }, timeout: TIMEOUT } as const;

function outputOf(id: string) {
  return { from: `steps.${id}.output` } as const;
}

/** A map's output is an array, which a merge cannot take, so it rides as `judge.output`. */
const JUDGED = { project: { from: "steps" }, fields: ["judge"] } as const;

const BOTH_JUDGED = { project: { from: "steps" }, fields: ["judge", "judgeParts"] } as const;

/** The chunks are already in the run log twice, as the map's input and each judge call's; evaluate re-derives them. */
const RULED = { project: outputOf("rules"), fields: ["items", "batch"] } as const;

/** An action that reaches the pull request's host through the credential bound to it for each of `sources`. */
export function hostAction(handler: "facts" | "mirror" | "execute", sources: Sources, input: Selector, after: readonly string[]) {
  const capability = handler === "facts" ? READ_PULL_REQUEST : WRITE_PULL_REQUEST;
  return action({ handler, input, after, credentials: sources, effect: { requires: [capability] }, timeout: TIMEOUT });
}

// Facts, mirror and execute reach the pull request's host through its bound credential; each host call they make is
// one call of the host's tool. The judge maps over the rules output's chunks, one System One call each; a second map
// asks focused's file questions only for the items it failed, and makes no call otherwise. An approval mail skips triage
// and executes the one held action it names; any other takes Ready off its head before triaging it. The mirror writes
// the verdict's comment and label (or build status) before execute, so a merge or close finds them on the head it
// closes; a mirror on a closed pull request would write nothing. Each gate branch evaluates, mirrors and executes on its own: a live run never hands a skipped step's output
// to a selector, so a join after the gate could not read the judge when it was skipped.
export function triageSteps(sources: Sources = ["github"]) {
  return {
    approval: action({ handler: "approval", input: { from: "trigger.payload" } }),
    approved: gate({ when: { from: "steps.approval.output.approved" }, then: "executeApproved", else: "unready", after: ["approval"] }),
    executeApproved: hostAction("execute", sources, outputOf("approval"), ["approved"]),
    unready: action({ handler: "unready", input: { from: "trigger.payload" }, after: ["approved"] }),
    markUnready: hostAction("mirror", sources, outputOf("unready"), ["unready"]),
    facts: hostAction("facts", sources, { from: "trigger.payload" }, ["markUnready"]),
    rules: action({ handler: "rules", input: outputOf("facts"), after: ["facts"] }),
    route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "judge", else: "evaluateRules", after: ["rules"] }),
    judge: map({ over: { from: "steps.rules.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["route"] }),
    parts: action({ handler: "parts", input: { merge: [RULED, JUDGED] }, after: ["judge"] }),
    judgeParts: map({ over: { from: "steps.parts.output.chunks" }, step: step({ agent: judgeAgent, input: { from: "trigger.payload" }, ...STEP }), after: ["parts"] }),
    evaluate: action({ handler: "evaluate", input: { merge: [RULED, BOTH_JUDGED] }, after: ["judgeParts"] }),
    mirror: hostAction("mirror", sources, outputOf("evaluate"), ["evaluate"]),
    execute: hostAction("execute", sources, outputOf("evaluate"), ["mirror"]),
    evaluateRules: action({ handler: "evaluate", input: outputOf("rules"), after: ["route"] }),
    mirrorRules: hostAction("mirror", sources, outputOf("evaluateRules"), ["evaluateRules"]),
    executeRules: hostAction("execute", sources, outputOf("evaluateRules"), ["mirrorRules"]),
  };
}
