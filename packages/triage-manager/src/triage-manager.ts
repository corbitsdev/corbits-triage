import { action, awaitSignal, defineWorkflow, gate, loop, onTrigger, SELF_RUN_RESOURCE, step, type Primitive, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "@corbits/triage-contracts";
import { credentialBindingsFor, judgeAgent, type Sources } from "@corbits/triage-workflows/agents";
import { WRITE_PULL_REQUEST } from "@corbits/triage-workflows/logic/host";
import { hostAction, triageSteps } from "@corbits/triage-workflows/triage-steps";
import { HUB_WRITE } from "./actions/hub.js";
import { REVIEW_DEADLINE_MS } from "./actions/review.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import { deployGrants, type Release } from "./release.js";

/** How often a manager waiting for its code review asks the hub whether the review reported. */
const POLL_MS = 30_000;

/** Enough passes to wait out a code review's deadline, and the events that arrive meanwhile. */
const PASSES = Math.ceil(REVIEW_DEADLINE_MS / POLL_MS) + 40;

const PAYLOAD = { project: { from: "trigger" }, fields: ["payload"] } as const;

/** A pass's input is `{ wait, payload }`, `payload` the mail that woke the manager; its steps read the mail as `payload`. */
const MAIL = { project: { from: "trigger.payload" }, fields: ["payload"] } as const;

/** The newest pull request mail take read back from the hub, which pr-triage's steps trust as the hub's. */
const TAKEN = { project: { from: "steps.take.output" }, fields: ["taken"] } as const;

function stepsOf(...ids: string[]) {
  return { project: { from: "steps" }, fields: ids } as const;
}

function hubAction(handler: string, input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/**
 * Code review between triage's verdict and its mirror. A pass that deploys the review mails it the request and posts
 * nothing; the pass that collects its report mirrors the verdict, then posts the review. A review whose mail failed by
 * its deadline, that reported a failure or that ran past its deadline leaves the verdict to go up alone, as does a host
 * whose release publishes no code review.
 */
function reviewSteps(sources: Sources): Record<string, Primitive> {
  return {
    reviewScope: action({ handler: "reviewScope", input: { merge: [MAIL, stepsOf("take", "evaluateRules")] }, after: ["evaluateRules"] }),
    reviewing: gate({ when: { from: "steps.reviewScope.output.deploy" }, then: "deployReview", else: "posting", after: ["reviewScope"] }),
    deployReview: hubAction("deployReview", { merge: [MAIL, stepsOf("take")] }, ["reviewing"]),
    mailReview: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "steps.deployReview.output.mail" }, after: ["deployReview"] }),
    reviewMailed: action({ handler: "reviewMailed", input: stepsOf("deployReview", "mailReview"), after: ["mailReview"] }),
    reviewSent: gate({ when: { from: "steps.reviewMailed.output.post" }, then: "mirrorRules", else: "doneReviewing", after: ["reviewMailed"] }),
    // A pass that mailed its review records it as a reviewer; a skipped step is missing from every selector, so this branch has its own done.
    doneReviewing: hubAction("done", { merge: [MAIL, stepsOf("take", "reviewMailed")] }, ["reviewSent"]),
    posting: gate({ when: { from: "steps.reviewScope.output.post" }, then: "mirrorRules", else: "done", after: ["reviewing"] }),
    postReview: action({ handler: "postReview", input: { merge: [MAIL, stepsOf("take")] }, after: ["mirrorRules"], credentials: sources, effect: { requires: [WRITE_PULL_REQUEST] } }),
  };
}

/**
 * One pass: take claims the pull request and its pending events. Each held Do approved since runs; then, when the head
 * is triaged, pr-triage's own steps run on the newest mail the hub recorded for it, so a head held for CI is marked
 * waiting and anything else is triaged and its automatic Dos run, posting nothing for rules that need the judge yet;
 * then done. A pass after one that waits for its code review first waits `POLL_MS`.
 */
function passOf(id: string, sources: Sources) {
  const { waiting, held, markWaiting, unready, rules, evaluateRules, mirrorRules, executeRules } = triageSteps(sources);
  return defineWorkflow({
    id: `${id}-pass`,
    trigger: { type: "manual" },
    steps: {
      paused: gate({ when: { from: "trigger.payload.wait" }, then: "poll", else: "take" }),
      // Nothing signals it: the timeout is the wait, which a loop body cannot sleep.
      poll: awaitSignal({ name: "manager-poll", timeout: POLL_MS, onTimeout: "take", after: ["paused"] }),
      take: hubAction("take", { from: "trigger.payload.payload" }, ["paused", "poll"]),
      ran: gate({ when: { from: "steps.take.output.run" }, then: "approvals", else: "done", after: ["take"] }),
      approvals: { ...hostAction("execute", sources, stepsOf("take"), ["ran"]), handler: "executeApprovals" },
      triaged: gate({ when: { from: "steps.take.output.triage" }, then: "waiting", else: "done", after: ["approvals"] }),
      waiting: { ...waiting, input: TAKEN, after: ["triaged"] },
      held,
      markWaiting,
      unready,
      facts: hostAction("facts", sources, TAKEN, ["unready"]),
      rules,
      route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "done", else: "evaluateRules", after: ["rules"] }),
      evaluateRules,
      ...reviewSteps(sources),
      mirrorRules: { ...mirrorRules, after: ["posting", "reviewSent"] },
      // The verdict's automatic Dos run as pr-triage runs them, after the verdict and any code review are up.
      executeRules: { ...executeRules, after: ["postReview"] },
      done: hubAction("done", { merge: [MAIL, stepsOf("take")] }, ["ran", "triaged", "markWaiting", "route", "posting", "executeRules"]),
    },
  });
}

/**
 * A pull request's manager under `id`, also its mail address, for the given hosts: the only workflow that writes to the
 * pull request, one live run per pull request, which runs only while it has work. A mail wakes it to run passes until
 * done ends the claim, when the run stops itself, or another run holds the claim. When the host's release publishes a
 * code review, it runs as its own deployment, which reports back; `codeReview`, the one published as the definition
 * loads, names the asset it declares the grants to deploy. Mail comes from the hub, the listener that deployed it and
 * the reviews it mailed.
 */
export function triageManager({ id, sources, codeReview }: { id: string; sources: Sources; codeReview: Release | undefined }) {
  const perMail = defineWorkflow({
    id: `${id}-run`,
    trigger: { type: "manual" },
    steps: {
      passes: loop({
        body: passOf(id, sources),
        input: { merge: [{ literal: { wait: false } }, PAYLOAD] },
        while: "again",
        carry: "next",
        maxIterations: PASSES,
        onExhausted: "stop",
      }),
      // Runs when the passes fail as well as when they run out, so a manager that cannot finish never keeps the claim.
      stop: hubAction("stop", { from: "trigger.payload" }, ["passes"]),
    },
  });
  const posts = ["executeApprovals", "postReview"].flatMap((handler) => sources.map((source) => ({ action: handler, handle: source, provider: source, name: source, locator: "tenant" }) as const));
  return defineWorkflow({
    id,
    credentialBindings: [...credentialBindingsFor(sources), ...posts],
    grantRequirements: [
      { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION, source: "creator" },
      { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
      ...(codeReview ? deployGrants(codeReview) : []),
    ],
    mailAccept: { invoker: true, correspondent: true, tenant: true },
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
