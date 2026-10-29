import { action, awaitSignal, defineWorkflow, gate, loop, onTrigger, SELF_RUN_RESOURCE, sleep, step, type Primitive, type Selector } from "@intx/workflow";
import { HUB_CREDENTIAL_HANDLE } from "@intx/types/credential-delivery";
import { MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE } from "@corbits/triage-contracts";
import { credentialBindingsFor, judgeAgent, type Sources } from "@corbits/triage-workflows/agents";
import { READ_PULL_REQUEST, WRITE_PULL_REQUEST } from "@corbits/triage-workflows/logic/host";
import { hostAction, triageSteps } from "@corbits/triage-workflows/triage-steps";
import { HUB_WRITE } from "./actions/hub.js";
import { LIFETIME_MS } from "./actions/manager.js";
import { mailDirector } from "./directors.js";
import { mailAgentOf } from "./mail.js";
import { deployGrants, type Release } from "./release.js";

/** How long a manager whose head awaits CI or a reviewer waits between passes for what it awaits. */
const POLL_MS = 30_000;

/**
 * A backstop on passes, twice a lifetime of polls for the passes events bring between them; the lifetime clock, which
 * take reads from the claim, ends a manager first.
 */
export const PASSES = Math.ceil((2 * LIFETIME_MS) / POLL_MS);

const PAYLOAD = { project: { from: "trigger" }, fields: ["payload"] } as const;

/** A pass's input is `{ wait, payload }`, `payload` the mail that woke the manager; its steps read the mail as `payload`. */
const MAIL = { project: { from: "trigger.payload" }, fields: ["payload"] } as const;

/** The newest pull request mail take read back from the hub, which pr-triage's steps trust as the hub's. */
const TAKEN = { project: { from: "steps.take.output" }, fields: ["taken"] } as const;

/** The verdict the pass posts and runs: evaluateRules', with each Do whose findings condition code review does not meet held. */
const CLEARED = { from: "steps.cleared.output" } as const;

function stepsOf(...ids: string[]) {
  return { project: { from: "steps" }, fields: ids } as const;
}

function hubAction(handler: string, input: Selector, after: readonly string[]) {
  return action({ handler, input, after, credentials: [HUB_CREDENTIAL_HANDLE], effect: { requires: [HUB_WRITE] } });
}

/** The in-progress comment of a pass that ends waiting for a reviewer, before its done. */
function progressAction(sources: Sources, mailed: readonly string[], after: readonly string[]) {
  return action({ handler: "progress", input: { merge: [MAIL, stepsOf("take", "rules", ...mailed)] }, after, credentials: sources, effect: { requires: [WRITE_PULL_REQUEST] } });
}

/**
 * Code review between triage's verdict and its mirror. A pass that deploys the review mails it the request and posts
 * nothing; the pass that collects its report mirrors the verdict, then posts the review. A review whose mail failed by
 * its deadline, that reported a failure or that ran past its deadline leaves the verdict to go up alone, as does a host
 * whose release publishes no code review.
 */
function reviewSteps(sources: Sources): Record<string, Primitive> {
  return {
    reviewScope: action({ handler: "reviewScope", input: { merge: [MAIL, stepsOf("take", "rules", "evaluateRules")] }, after: ["evaluateRules"] }),
    // After reviewScope, so a review the policy left out is told from one that is due; the verdict goes up from here.
    cleared: action({ handler: "cleared", input: stepsOf("take", "rules", "evaluateRules", "reviewScope"), after: ["reviewScope"] }),
    reviewing: gate({ when: { from: "steps.reviewScope.output.deploy" }, then: "deployReview", else: "posting", after: ["cleared"] }),
    deployReview: hubAction("deployReview", { merge: [MAIL, stepsOf("take")] }, ["reviewing"]),
    mailReview: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "steps.deployReview.output.mail" }, after: ["deployReview"] }),
    reviewMailed: action({ handler: "reviewMailed", input: stepsOf("deployReview", "mailReview"), after: ["mailReview"] }),
    reviewSent: gate({ when: { from: "steps.reviewMailed.output.post" }, then: "mirrorRules", else: "progressReviewing", after: ["reviewMailed"] }),
    progressReviewing: progressAction(sources, ["reviewMailed"], ["reviewSent"]),
    // A pass that mailed its review records it as a reviewer; a skipped step is missing from every selector, so this branch has its own done.
    doneReviewing: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals", "rules", "reviewMailed")] }, ["progressReviewing"]),
    posting: gate({ when: { from: "steps.reviewScope.output.post" }, then: "mirrorRules", else: "progressAwaiting", after: ["reviewing"] }),
    postReview: action({ handler: "postReview", input: { merge: [MAIL, stepsOf("take", "reviewScope")] }, after: ["mirrorRules"], credentials: sources, effect: { requires: [WRITE_PULL_REQUEST] } }),
  };
}

/**
 * The judge between the rules and the verdict. A pass that deploys it mails the rules output and posts nothing; while
 * the host's checks run it is not deployed, and the verdict waits for them. The pass that has the judge's verdict posts
 * it, and code review when the policy asks for it, still posting nothing while a review is out. A judge the release
 * does not publish posts nothing. One that failed, could not be mailed, or ran past its deadline goes on to the
 * machine verdict and is not deployed again on that pass.
 */
function judgeSteps(sources: Sources): Record<string, Primitive> {
  return {
    judgeScope: action({ handler: "judgeScope", input: { merge: [MAIL, stepsOf("take", "rules")] }, after: ["route"] }),
    judging: gate({ when: { from: "steps.judgeScope.output.deploy" }, then: "deployJudge", else: "judgeWait", after: ["judgeScope"] }),
    deployJudge: hubAction("deployJudge", { merge: [MAIL, stepsOf("take", "rules")] }, ["judging"]),
    mailJudge: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "steps.deployJudge.output.mail" }, after: ["deployJudge"] }),
    judgeMailed: action({ handler: "judgeMailed", input: stepsOf("deployJudge", "mailJudge"), after: ["mailJudge"] }),
    judgeSent: gate({ when: { from: "steps.judgeMailed.output.post" }, then: "evaluateRules", else: "reviewEarly", after: ["judgeMailed"] }),
    // Code review goes out with the judge once the rules gate opens, unless its `when` waits for the verdict; the pass
    // that collects both reports posts the review with the final verdict.
    reviewEarly: action({ handler: "reviewEarly", input: { merge: [MAIL, stepsOf("take", "rules")] }, after: ["judgeSent"] }),
    earlyReviewing: gate({ when: { from: "steps.reviewEarly.output.deploy" }, then: "deployEarlyReview", else: "progressJudging", after: ["reviewEarly"] }),
    deployEarlyReview: hubAction("deployReview", { merge: [MAIL, stepsOf("take")] }, ["earlyReviewing"]),
    mailEarlyReview: step({ agent: mailAgentOf(mailDirector, judgeAgent.inference, { tolerate: true }), input: { from: "steps.deployEarlyReview.output.mail" }, after: ["deployEarlyReview"] }),
    earlyReviewMailed: action({ handler: "earlyReviewMailed", input: stepsOf("deployEarlyReview", "mailEarlyReview"), after: ["mailEarlyReview"] }),
    // A pass that mailed its judge records it, and a review mailed with it, as reviewers; a skipped step is missing from
    // every selector, so each branch has its own done.
    progressJudging: progressAction(sources, ["judgeMailed"], ["earlyReviewing"]),
    doneJudging: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals", "rules", "judgeMailed")] }, ["progressJudging"]),
    progressJudgingReview: progressAction(sources, ["judgeMailed", "earlyReviewMailed"], ["earlyReviewMailed"]),
    doneJudgingReview: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals", "rules", "judgeMailed", "earlyReviewMailed")] }, ["progressJudgingReview"]),
    judgeWait: gate({ when: { from: "steps.judgeScope.output.post" }, then: "evaluateRules", else: "progressAwaiting", after: ["judging"] }),
  };
}

/**
 * One pass: take claims the pull request and its pending events. Each held Do approved since runs; then, when the head
 * is triaged, pr-triage's own steps run on the newest mail the hub recorded for it. A verdict that waits for the host's
 * checks shows the waiting marker. A policy of only deterministic rules is triaged on this pass. One that asks the
 * judge or for code review posts once both have reported or given up. A pass after one whose head awaits CI or a
 * reviewer first waits `POLL_MS`.
 */
function passOf(id: string, sources: Sources) {
  const { unready, markUnready, rules, mirrorRules, executeRules } = triageSteps(sources);
  return defineWorkflow({
    id: `${id}-pass`,
    trigger: { type: "manual" },
    steps: {
      paused: gate({ when: { from: "trigger.payload.wait" }, then: "poll", else: "take" }),
      // Nothing signals it: the timeout is the wait, which a loop body cannot sleep.
      poll: awaitSignal({ name: "manager-poll", timeout: POLL_MS, onTimeout: "take", after: ["paused"] }),
      take: hubAction("take", { from: "trigger.payload.payload" }, ["paused", "poll"]),
      // Runs on every pass, reading nothing when take names no thread, so every branch's done records what it read.
      findingThreads: action({ handler: "findingThreads", input: { merge: [MAIL, stepsOf("take")] }, after: ["take"], credentials: sources, effect: { requires: [READ_PULL_REQUEST] } }),
      // Runs on every pass, approving nothing when there is nothing to run, so every branch's done reports its outcomes.
      approvals: { ...hostAction("execute", sources, stepsOf("take"), ["findingThreads"]), handler: "executeApprovals" },
      ran: gate({ when: { from: "steps.take.output.run" }, then: "triaged", else: "done", after: ["approvals"] }),
      triaged: gate({ when: { from: "steps.take.output.triage" }, then: "unready", else: "done", after: ["ran"] }),
      unready: { ...unready, input: TAKEN, after: ["triaged"] },
      markUnready,
      facts: hostAction("facts", sources, TAKEN, ["markUnready"]),
      rules,
      route: gate({ when: { from: "steps.rules.output.needsJudgment" }, then: "judgeScope", else: "evaluateRules", after: ["rules"] }),
      ...judgeSteps(sources),
      evaluateRules: action({ handler: "verdict", input: { merge: [MAIL, stepsOf("take", "rules")] }, after: ["route", "judgeWait", "judgeSent"] }),
      ...reviewSteps(sources),
      mirrorRules: { ...mirrorRules, input: CLEARED, after: ["posting", "reviewSent"] },
      // The verdict's automatic Dos run as pr-triage runs them, after the verdict and any code review are up.
      executeRules: { ...executeRules, input: CLEARED, after: ["postReview"] },
      // A skipped step is missing from every selector, so the branches that report a posted verdict, or a head triaged
      // while a reviewer is out, have their own done.
      donePosted: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals", "rules", "cleared", "reviewScope", "mirrorRules", "postReview", "executeRules")] }, ["executeRules"]),
      progressAwaiting: progressAction(sources, [], ["judgeWait", "posting"]),
      doneAwaiting: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals", "rules")] }, ["progressAwaiting"]),
      done: hubAction("done", { merge: [MAIL, stepsOf("take", "findingThreads", "approvals")] }, ["ran", "triaged"]),
    },
  });
}

/**
 * A pull request's manager under `id`, also its mail address, for the given hosts: the only workflow that writes to the
 * pull request, one live run per pull request, which lives until its head has its final verdict. A mail wakes it to run
 * passes until done ends the claim or another run holds the claim, after which its last step stops it. While its head
 * awaits CI, the judge or code review, it polls every `POLL_MS` for the event that brings it, which the hub records and
 * mails it: a check finishing, a reviewer's result, or a new head, whose pass starts over. When the host's release
 * publishes a code review or a judge, each runs as its own deployment, which reports its result to the hub.
 * `codeReview` and `judge`, the ones published as the definition loads, name the assets it declares the grants to
 * deploy. Mail comes from the hub and the listener that deployed it.
 */
export function triageManager({ id, sources, codeReview, judge }: { id: string; sources: Sources; codeReview: Release | undefined; judge?: Release }) {
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
        onExhausted: "exhausted",
      }),
      // Stock prunes a loop's onExhausted when the loop converges; stop joins both branches so it runs once on every outcome.
      exhausted: sleep({ duration: 0, drainBehavior: "wait", after: ["passes"] }),
      // The run's only end, its last step, so a manager that cannot finish never keeps the claim and no step runs after it.
      stop: hubAction("stop", { from: "trigger.payload" }, ["passes", "exhausted"]),
    },
  });
  const hostSteps = ["executeApprovals", "postReview", "progress", "findingThreads"].flatMap((handler) => sources.map((source) => ({ action: handler, handle: source, provider: source, name: source, locator: "tenant" }) as const));
  return defineWorkflow({
    id,
    credentialBindings: [...credentialBindingsFor(sources), ...hostSteps],
    grantRequirements: [
      { resource: MANAGER_STATE_RESOURCE, action: MANAGER_STATE_ACTION, source: "creator" },
      { resource: SELF_RUN_RESOURCE, action: "manage", source: "creator" },
      ...(codeReview ? deployGrants(codeReview) : []),
      ...(judge ? deployGrants(judge) : []),
    ],
    mailAccept: { invoker: true, tenant: true },
    steps: {
      events: onTrigger({ on: { type: "mail", to: id }, body: perMail, onBodyFailure: "tolerate" }),
    },
  });
}
