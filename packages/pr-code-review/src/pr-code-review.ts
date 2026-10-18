import { action, defineWorkflow, map, onTrigger, step } from "@intx/workflow";
import { credentialBindingsFor, type CodeReviewAgents, type Sources } from "./agents.js";

export const PR_CODE_REVIEW_ADDRESS = "pr-code-review";

/** Every provider's package deploys a host's review under the same id, so the hub mails it whichever provider runs it. */
export const PR_CODE_REVIEW_GITHUB_ADDRESS = "pr-code-review-github";

export const PR_CODE_REVIEW_BITBUCKET_DATACENTER_ADDRESS = "pr-code-review-bitbucket-datacenter";

const TIMEOUT = 10 * 60_000;

/** Its own sidecar, never one shared with other work: the review checks out the pull request's code. */
export const CODE_REVIEW_PLACEMENT = { capabilities: [{ capability: "isolation:workload", effect: "require" as const }] };

function stepsOf(...ids: string[]) {
  return { project: { from: "steps" }, fields: ids } as const;
}

function inferenceOf(role: string) {
  return { from: `steps.reviewInput.output.inference.${role}` };
}

/**
 * reviewInput → plan → findDiff ‖ findRepo → candidates (fold exact duplicates) → consolidate (read the cited lines at
 * the head, group findings by defect) → checks (every group, by severity then agreement) → check (one call per group,
 * only when the request asks for it) → writeInput → write → review (the review to post).
 * Each model step's effort comes from the request, else the profile; its model is the one the profile names for it.
 * The definition for the given hosts under `id`, also its mail address, binds only their read bundles' credentials; the
 * deployed packages are one per host, and a request's checkout names that host.
 */
export function codeReviewWorkflow({ checkAgent, consolidateAgent, finderAgent, planAgent, repoFinderAgent, writeAgent }: CodeReviewAgents) {
  return function prCodeReview({ id = PR_CODE_REVIEW_ADDRESS, sources }: { id?: string; sources: Sources }) {
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
        consolidate: step({ agent: consolidateAgent(sources), input: { from: "steps.candidates.output.consolidate" }, inference: { from: "steps.candidates.output.inference" }, after: ["candidates"], timeout: TIMEOUT }),
        checks: action({ handler: "checks", input: stepsOf("reviewInput", "candidates", "consolidate"), after: ["consolidate"] }),
        check: map({
          over: { from: "steps.checks.output.checks" },
          step: step({ agent: checkAgent, input: { from: "trigger.payload.text" }, inference: { from: "trigger.payload.inference" }, timeout: TIMEOUT }),
          after: ["checks"],
        }),
        writeInput: action({ handler: "writeInput", input: stepsOf("reviewInput", "candidates", "checks", "check"), after: ["check"] }),
        write: step({ agent: writeAgent, input: { from: "steps.writeInput.output.text" }, inference: { from: "steps.writeInput.output.inference" }, after: ["writeInput"], timeout: TIMEOUT }),
        review: action({ handler: "review", input: stepsOf("reviewInput", "writeInput", "write"), after: ["write"] }),
      },
    });
    return defineWorkflow({
      id,
      credentialBindings: credentialBindingsFor(sources),
      sidecarPlacement: CODE_REVIEW_PLACEMENT,
      steps: { events: onTrigger({ on: { type: "mail", to: id }, body, onBodyFailure: "tolerate" }) },
    });
  };
}
