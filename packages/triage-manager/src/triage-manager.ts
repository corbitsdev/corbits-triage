import { action, defineWorkflow, gate, onTrigger, SELF_RUN_RESOURCE, step, type Primitive, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "@corbits/triage-contracts";
import { credentialBindingsFor, judgeAgent, type Sources } from "@corbits/triage-workflows/agents";
import { WRITE_PULL_REQUEST } from "@corbits/triage-workflows/logic/host";
import { hostAction, triageSteps } from "@corbits/triage-workflows/triage-steps";
import { HUB_WRITE } from "./actions/hub.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import type { Release } from "./release.js";

const TRIAGE_MANAGER_ADDRESS = "triage-manager";

const PAYLOAD = { project: { from: "trigger" }, fields: ["payload"] } as const;

function stepsOf(...ids: string[]) {
  return { project: { from: "steps" }, fields: ids } as const;
}

function hubAction(handler: string, input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/**
 * Code review between triage's verdict and its mirror: a pass that deploys the review mails it the request and posts
 * nothing; the pass that collects its review mirrors the verdict, then posts the review.
 */
function reviewSteps(sources: Sources, review: Release): Record<string, Primitive> {
  return {
    reviewScope: action({ handler: "reviewScope", input: { merge: [PAYLOAD, stepsOf("take", "evaluateRules")] }, after: ["evaluateRules"] }),
    reviewing: gate({ when: { from: "steps.reviewScope.output.deploy" }, then: "deployReview", else: "posting", after: ["reviewScope"] }),
    deployReview: hubAction("deployReview", { merge: [{ literal: { release: review } }, PAYLOAD, stepsOf("take")] }, ["reviewing"]),
    mailReview: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference), input: { from: "steps.deployReview.output.mail" }, after: ["deployReview"] }),
    // A pass that deploys the review records it as a reviewer; a skipped step is missing from every selector, so this branch has its own done.
    doneReviewing: hubAction("done", { merge: [PAYLOAD, stepsOf("take", "deployReview")] }, ["mailReview"]),
    posting: gate({ when: { from: "steps.reviewScope.output.post" }, then: "mirrorRules", else: "done", after: ["reviewing"] }),
    postReview: action({ handler: "postReview", input: { merge: [PAYLOAD, stepsOf("take")] }, after: ["mirrorRules"], credentials: sources, effect: { requires: [WRITE_PULL_REQUEST] } }),
  };
}

/**
 * A pull request's manager under `id`, also its mail address, for the given hosts: the only workflow that writes to
 * the pull request. Each mail runs one body: take claims the pull request and its pending events, stage 1 runs as
 * pr-triage's own steps over the mail's request, then done; the run stops itself when done ends its claim. Rules that
 * need the judge post nothing yet. With `review`, code review runs as its own deployment, which reports back, and the
 * verdict and the review go up together. Mail comes only from the listener that deployed it and the reviews it mailed.
 */
export function triageManager({ id = TRIAGE_MANAGER_ADDRESS, sources, review }: { id?: string; sources: Sources; review?: Release }) {
  const { rules, evaluateRules, mirrorRules } = triageSteps(sources);
  const perMail = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      take: hubAction("take", { from: "trigger.payload" }, []),
      taken: gate({ when: { from: "steps.take.output.taken" }, then: "facts", else: "done", after: ["take"] }),
      facts: hostAction("facts", sources, { from: "steps.take.output.request" }, ["taken"]),
      rules,
      route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "done", else: "evaluateRules", after: ["rules"] }),
      evaluateRules,
      ...(review ? { ...reviewSteps(sources, review), mirrorRules: { ...mirrorRules, after: ["posting"] } } : { mirrorRules }),
      done: hubAction("done", { merge: [PAYLOAD, stepsOf("take")] }, ["taken", "route", ...(review ? ["posting", "postReview"] : ["mirrorRules"])]),
    },
  });
  const posts = review ? sources.map((source) => ({ action: "postReview", handle: source, provider: source, name: source, locator: "tenant" }) as const) : [];
  return defineWorkflow({
    id,
    credentialBindings: [...credentialBindingsFor(sources).filter((binding) => binding.action !== "execute"), ...posts],
    grantRequirements: [
      { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION, source: "creator" },
      { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
      ...(review ? [{ resource: "workflow:*", action: "create", source: "creator" as const }, { resource: `asset:${review.workflow.assetId}`, action: "read", source: "creator" as const }] : []),
    ],
    mailAccept: { invoker: true, correspondent: true },
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}

/** The library definition the tests run; the deployed packages are its per-host builds. */
export const workflow = triageManager({ sources: ["github"] });
