import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { checkAgent, convergeAgent, credentialBindingsFor, finderAgent, gatherAgent, planAgent, repoFinderAgent, writeAgent, type Sources } from "./agents.js";

export const PR_CODE_REVIEW_ADDRESS = "pr-code-review";

const TIMEOUT = 10 * 60_000;

function stepsOf(...ids: string[]) {
  return { project: { from: "steps" }, fields: ids } as const;
}

function inferenceOf(role: string) {
  return { from: `steps.reviewInput.output.inference.${role}` };
}

/**
 * reviewInput → plan → findDiff ‖ findRepo → candidates → gather (read cited files at the head) → merge (quoted code
 * in file, re-anchor, drop exact duplicates) → converge (group candidates by defect) → checks → check (one call per
 * group's representative) → writeInput → write → review (the review to post).
 * Each model step's effort comes from the request; its model is the source its agent resolves to.
 * The definition for the given hosts under `id`, also its mail address, binds only their read bundles' credentials; the
 * deployed packages are one per host, and a request's checkout names that host.
 */
export function prCodeReview({ id = PR_CODE_REVIEW_ADDRESS, sources }: { id?: string; sources: Sources }) {
  const body = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      reviewInput: action({ handler: "reviewInput", input: { from: "trigger.payload" } }),
      plan: step({ agent: planAgent, input: { from: "steps.reviewInput.output.plan" }, inference: inferenceOf("plan"), after: ["reviewInput"], timeout: TIMEOUT }),
      findersInput: action({ handler: "findersInput", input: stepsOf("reviewInput", "plan"), after: ["plan"] }),
      findDiff: step({ agent: finderAgent(), input: { from: "steps.findersInput.output.diff" }, inference: inferenceOf("diffFinder"), after: ["findersInput"], timeout: TIMEOUT }),
      findRepo: step({ agent: repoFinderAgent(sources), input: { from: "steps.findersInput.output.repo" }, inference: inferenceOf("repoFinder"), after: ["findersInput"], timeout: TIMEOUT }),
      candidates: action({ handler: "candidates", input: stepsOf("reviewInput", "findDiff", "findRepo"), after: ["findDiff", "findRepo"] }),
      gather: step({ agent: gatherAgent(sources), input: { from: "steps.candidates.output.gather" }, after: ["candidates"], timeout: TIMEOUT }),
      merge: action({ handler: "merge", input: stepsOf("reviewInput", "candidates", "gather"), after: ["gather"] }),
      converge: step({ agent: convergeAgent, input: { from: "steps.merge.output.converge" }, inference: { from: "steps.merge.output.inference" }, after: ["merge"], timeout: TIMEOUT }),
      checks: action({ handler: "checks", input: stepsOf("reviewInput", "gather", "merge", "converge"), after: ["converge"] }),
      check: map({
        over: { from: "steps.checks.output.checks" },
        step: step({ agent: checkAgent, input: { from: "trigger.payload.text" }, inference: { from: "trigger.payload.inference" }, timeout: TIMEOUT }),
        after: ["checks"],
      }),
      writeInput: action({ handler: "writeInput", input: stepsOf("reviewInput", "candidates", "checks", "check"), after: ["check"] }),
      write: step({ agent: writeAgent, input: { from: "steps.writeInput.output.text" }, inference: { from: "steps.writeInput.output.inference" }, after: ["writeInput"], timeout: TIMEOUT }),
      review: action({ handler: "review", input: stepsOf("writeInput", "write"), after: ["write"] }),
    },
  });
  return defineWorkflow({
    id,
    credentialBindings: credentialBindingsFor(sources),
    steps: { events: onTrigger({ on: { type: "mail", to: id }, body, onBodyFailure: "tolerate" }) },
  });
}

/** The library definition the evals run; the deployed packages are its per-host builds. */
export const workflow = prCodeReview({ sources: ["github"] });
