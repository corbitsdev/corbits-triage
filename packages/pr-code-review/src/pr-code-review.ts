import { action, defineWorkflow, map, onTrigger, SELF_RUN_RESOURCE, step, type Primitive, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { HUB_WRITE } from "@corbits/triage-manager/actions/hub";
import { READ_REPOSITORY } from "./actions/checkout.js";
import { credentialBindingsFor, type CodeReviewAgents, type Sources } from "./agents.js";
import { MODEL_ATTEMPTS } from "./failures.js";

export const PR_CODE_REVIEW_ADDRESS = "pr-code-review";

const TIMEOUT = 10 * 60_000;

/** A model step whose call failed or whose answer couldn't be read asks again, waiting out a brief overload. */
const MODEL_RETRY = { maxAttempts: MODEL_ATTEMPTS, initialBackoffMs: 5_000 };

/** Its own sidecar, never one shared with other work: the review checks out the pull request's code. */
export const CODE_REVIEW_PLACEMENT = { capabilities: [{ capability: "isolation:workload", effect: "require" as const }] };

/**
 * Checks the head out on the sidecar through the credential bound to it for each of `sources` and writes the diff into
 * it; its output names the folder.
 */
export function checkoutAction(sources: Sources, input: Selector, after: readonly string[]) {
  return action({ handler: "checkout", input, after, credentials: sources, effect: { requires: [READ_REPOSITORY] }, timeout: TIMEOUT });
}

/** Where a review's steps sit in a definition: every step id under `prefix`, the request read from `request`, after `after`. */
export interface CodeReviewPlace {
  prefix: string;
  request: Selector;
  after?: readonly string[];
}

/**
 * reviewInput → checkout (the head, with the diff written into it) → plan ‖ lint → findDiff ‖ findRepo → candidates (fold
 * exact duplicates) → consolidate (read the cited lines at the head, group findings by defect) → checks (the groups by severity
 * then agreement, up to the review's number of checks) → check (verify each group against its diff hunk and the checkout) → writeInput (the groups
 * to post) → write → review (the review to post, and the groups it left out).
 * Each model step's effort comes from the request, else the profile; its model is the one the profile names for it.
 * Under a prefix, every action's input also carries it as `$prefix`, so the action finds its steps' outputs.
 */
export function codeReviewSteps(agents: CodeReviewAgents, sources: Sources, { prefix, request, after }: CodeReviewPlace): Record<string, Primitive> {
  const { checkAgent, consolidateAgent, finderAgent, planAgent, repoFinderAgent, writeAgent } = agents;
  function id(name: string) {
    return `${prefix}${name}`;
  }
  function stepsOf(...names: string[]): Selector {
    const steps = { project: { from: "steps" }, fields: names.map(id) };
    return prefix === "" ? steps : { merge: [{ literal: { $prefix: prefix } }, steps] };
  }
  function outputOf(name: string, path: string) {
    return { from: `steps.${id(name)}.output.${path}` };
  }
  return {
    [id("reviewInput")]: action({ handler: "reviewInput", input: request, ...(after && { after }) }),
    [id("checkout")]: checkoutAction(sources, { merge: [outputOf("reviewInput", "request.checkout"), { project: outputOf("reviewInput", "request"), fields: ["diff"] }] }, [id("reviewInput")]),
    [id("plan")]: step({ agent: planAgent, input: outputOf("reviewInput", "plan"), inference: outputOf("reviewInput", "inference.plan"), after: [id("checkout")], timeout: TIMEOUT, retry: MODEL_RETRY }),
    [id("lint")]: action({
      handler: "lint",
      input: { merge: [{ project: { from: `steps.${id("checkout")}.output` }, fields: ["path"] }, { project: outputOf("reviewInput", "request"), fields: ["diff"] }] },
      after: [id("checkout")],
      timeout: TIMEOUT,
    }),
    [id("findersInput")]: action({ handler: "findersInput", input: stepsOf("reviewInput", "plan"), after: [id("plan")] }),
    [id("findDiff")]: step({ agent: finderAgent(), input: outputOf("findersInput", "diff"), inference: outputOf("reviewInput", "inference.diffFinder"), after: [id("findersInput"), id("checkout")], timeout: TIMEOUT, retry: MODEL_RETRY }),
    [id("findRepo")]: step({ agent: repoFinderAgent(), input: outputOf("findersInput", "repo"), inference: outputOf("reviewInput", "inference.repoFinder"), after: [id("findersInput"), id("checkout")], timeout: TIMEOUT, retry: MODEL_RETRY }),
    [id("candidates")]: action({ handler: "candidates", input: stepsOf("reviewInput", "findDiff", "findRepo"), after: [id("findDiff"), id("findRepo")] }),
    [id("consolidate")]: step({ agent: consolidateAgent(sources), input: outputOf("candidates", "consolidate"), inference: outputOf("candidates", "inference"), after: [id("candidates")], timeout: TIMEOUT, retry: MODEL_RETRY }),
    [id("checks")]: action({ handler: "checks", input: stepsOf("reviewInput", "candidates", "consolidate"), after: [id("consolidate")] }),
    [id("check")]: map({
      over: outputOf("checks", "checks"),
      step: step({ agent: checkAgent, input: { from: "trigger.payload.text" }, inference: { from: "trigger.payload.inference" }, timeout: TIMEOUT, retry: MODEL_RETRY }),
      after: [id("checks")],
    }),
    [id("writeInput")]: action({ handler: "writeInput", input: stepsOf("reviewInput", "candidates", "checks", "check"), after: [id("check")] }),
    [id("write")]: step({ agent: writeAgent, input: outputOf("writeInput", "text"), inference: outputOf("writeInput", "inference"), after: [id("writeInput")], timeout: TIMEOUT, retry: MODEL_RETRY }),
    [id("review")]: action({ handler: "review", input: stepsOf("writeInput", "write"), after: [id("write")] }),
  };
}

/**
 * The review on its own, which the tests and evals run: the definition for the given hosts under `id`, also its mail
 * address, binds only their credentials, and a request's checkout names its host. The checkout's folder is on the
 * sidecar, which the review has to itself.
 */
export function codeReviewWorkflow(agents: CodeReviewAgents) {
  return function prCodeReview({ id = PR_CODE_REVIEW_ADDRESS, sources }: { id?: string; sources: Sources }) {
    const body = defineWorkflow({
      id: `${id}-run`,
      trigger: { type: "manual" },
      steps: codeReviewSteps(agents, sources, { prefix: "", request: { from: "trigger.payload" } }),
    });
    return defineWorkflow({
      id,
      credentialBindings: credentialBindingsFor(sources),
      mailAccept: TRIAGE_MAIL_ACCEPT,
      sidecarPlacement: CODE_REVIEW_PLACEMENT,
      steps: { events: onTrigger({ on: { type: "mail", to: id }, body, onBodyFailure: "tolerate" }) },
    });
  };
}

function hubAction(handler: string, input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/**
 * The review a pull request's manager deploys, under `id`, also its mail address: it reviews the request the manager
 * mails it, reports the review through the hub, or that it did not finish, which wakes the pull request's manager, then
 * stops, whatever failed before. It posts nothing to the pull request. Only the manager that deployed it may mail it.
 */
export function codeReviewReviewer(agents: CodeReviewAgents) {
  return function prCodeReviewReviewer({ id, sources }: { id: string; sources: Sources }) {
    const body = defineWorkflow({
      id: `${id}-run`,
      trigger: { type: "manual" },
      steps: {
        reviewRequest: action({ handler: "reviewRequest", input: { from: "trigger.payload" } }),
        ...codeReviewSteps(agents, sources, { prefix: "", request: { from: "steps.reviewRequest.output.request" }, after: ["reviewRequest"] }),
        // Stock runs a step whose dependencies failed, so the report and the stop run however the review ended.
        report: hubAction("report", { merge: [{ from: "steps" }, { project: { from: "trigger" }, fields: ["payload"] }] }, ["review"]),
        stop: hubAction("stop", { from: "trigger.payload" }, ["report"]),
      },
    });
    return defineWorkflow({
      id,
      credentialBindings: credentialBindingsFor(sources),
      grantRequirements: [
        { resource: MANAGER_RESULT_RESOURCE, action: MANAGER_RESULT_ACTION, source: "creator" },
        { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
      ],
      mailAccept: { invoker: true },
      sidecarPlacement: CODE_REVIEW_PLACEMENT,
      steps: { events: onTrigger({ on: { type: "mail", to: id }, body, onBodyFailure: "tolerate" }) },
    });
  };
}
