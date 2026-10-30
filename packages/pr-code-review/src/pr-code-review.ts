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

/** Direct patch bundles → finder → exact duplicate folding → existing checks → finder-word review.
 * Under a prefix, action inputs carry `$prefix` so their step outputs remain addressable.
 */
export function codeReviewSteps(agents: CodeReviewAgents, sources: Sources, { prefix, request, after }: CodeReviewPlace): Record<string, Primitive> {
  const { checkAgent, finderAgent } = agents;
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
    [id("lint")]: action({
      handler: "lint",
      input: { merge: [{ project: { from: `steps.${id("checkout")}.output` }, fields: ["path"] }, { project: outputOf("reviewInput", "request"), fields: ["diff"] }] },
      after: [id("checkout")], timeout: TIMEOUT,
    }),
    [id("findersInput")]: action({ handler: "findersInput", input: stepsOf("reviewInput"), after: [id("reviewInput")] }),
    [id("find")]: map({
      over: outputOf("findersInput", "bundles"),
      step: step({ agent: finderAgent(), input: { from: "trigger.payload" }, inference: outputOf("reviewInput", "inference.diffFinder"), timeout: TIMEOUT, retry: MODEL_RETRY }),
      after: [id("findersInput"), id("checkout")],
    }),
    [id("candidates")]: action({ handler: "candidates", input: stepsOf("reviewInput", "find"), after: [id("find")] }),
    [id("checks")]: action({ handler: "checks", input: stepsOf("reviewInput", "candidates"), after: [id("candidates")] }),
    [id("check")]: map({
      over: outputOf("checks", "checks"),
      step: step({ agent: checkAgent, input: { from: "trigger.payload.text" }, inference: { from: "trigger.payload.inference" }, timeout: TIMEOUT, retry: MODEL_RETRY }),
      after: [id("checks")],
    }),
    [id("review")]: action({ handler: "review", input: stepsOf("candidates", "checks", "check"), after: [id("check")] }),
  };
}

/** Standalone review definition used by tests and evals. */
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
