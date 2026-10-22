import { action, defineWorkflow, gate, onTrigger, type Primitive } from "@intx/workflow";
import { TRIAGE_MAIL_ACCEPT } from "@corbits/triage-contracts";
import { credentialBindingsFor as codeReviewBindings, type CodeReviewAgents } from "@corbits/pr-code-review/agents";
import { CODE_REVIEW_PLACEMENT, codeReviewSteps } from "@corbits/pr-code-review/pr-code-review";
import { agents } from "@corbits/pr-code-review-anthropic/agents";
import { credentialBindingsFor as triageBindings, type Sources } from "@corbits/triage-workflows/agents";
import { hostAction, triageSteps } from "@corbits/triage-workflows/triage-steps";
import { CODE_REVIEW, CODE_REVIEW_PREFIX, CODE_REVIEW_REVIEW, CODE_REVIEW_SCOPE } from "./actions/code-review.js";
import { DECIDE } from "./actions/decide.js";
import { EXECUTE_DECIDED } from "./actions/execute.js";

const PR_WORKFLOW_ANTHROPIC_ADDRESS = "pr-workflow-anthropic";

const GATE = `${CODE_REVIEW_PREFIX}gate`;

/** pr-triage executes on each of its branches; here one `execute`, which the hub reads as triage's, after both and code review. */
const TRIAGE_EXECUTES = new Set(["execute", "executeRules"]);

/** Triage's credential bindings and code review's, and the host's for the execute that runs what `decide` chose, for the hosts in `sources`. */
export function credentialBindingsFor(sources: Sources) {
  const decided = sources.map((source) => ({ action: EXECUTE_DECIDED, handle: source, provider: source, name: source, locator: "tenant" }) as const);
  return [...triageBindings(sources), ...decided, ...codeReviewBindings(sources)];
}

function withoutExecutes(steps: Record<string, Primitive>): Record<string, Primitive> {
  return Object.fromEntries(Object.entries(steps).filter(([id]) => !TRIAGE_EXECUTES.has(id)));
}

/**
 * Triage's steps as pr-triage runs them, then code review's, run by `agents`, behind a gate. The scope reads the
 * trigger's code review part, triage's verdict and the changed files once triage has decided, whichever branch it took;
 * an approval or waiting mail never triages, so code review never runs for one. Code review's steps sit under
 * `codeReview_`, and `codeReview` records its outcome. `decide` then applies the policy's rules once, and execute runs
 * only the kinds it chose. Stock runs a step whose dependency failed, so ordering alone would not hold execute back:
 * execute reads the decision and fails without one.
 * The definition for the given hosts under `id`, also its mail address, binds only their credentials, and needs a
 * sidecar of its own, as code review checks the head out on it.
 */
export function prWorkflowOf(agents: CodeReviewAgents) {
  return function prWorkflow({ id = PR_WORKFLOW_ANTHROPIC_ADDRESS, sources }: { id?: string; sources: Sources }) {
    const perPr = defineWorkflow({
      id: `${id}-run`,
      trigger: { type: "manual" },
      steps: {
        ...withoutExecutes(triageSteps(sources)),
        [CODE_REVIEW_SCOPE]: action({ handler: "codeReviewScope", input: { merge: [{ from: "steps" }, { project: { from: "trigger" }, fields: ["payload"] }] }, after: ["evaluate", "evaluateRules"] }),
        [GATE]: gate({ when: { from: `steps.${CODE_REVIEW_SCOPE}.output.open` }, then: `${CODE_REVIEW_PREFIX}reviewInput`, else: CODE_REVIEW, after: [CODE_REVIEW_SCOPE] }),
        ...codeReviewSteps(agents, sources, { prefix: CODE_REVIEW_PREFIX, request: { from: `steps.${CODE_REVIEW_SCOPE}.output.request` }, after: [GATE] }),
        [CODE_REVIEW]: action({ handler: "codeReviewOutcome", input: { from: "steps" }, after: [GATE, CODE_REVIEW_REVIEW] }),
        [DECIDE]: action({ handler: "decideActions", input: { merge: [{ from: "steps" }, { project: { from: "trigger" }, fields: ["payload"] }] }, after: [CODE_REVIEW] }),
        // Triage's host action under the handler that runs what decide chose; `executeApproved` keeps triage's own.
        execute: { ...hostAction("execute", sources, { from: `steps.${DECIDE}.output` }, ["mirror", "mirrorRules", DECIDE]), handler: EXECUTE_DECIDED },
      },
    });
    return defineWorkflow({
      id,
      credentialBindings: credentialBindingsFor(sources),
      mailAccept: TRIAGE_MAIL_ACCEPT,
      sidecarPlacement: CODE_REVIEW_PLACEMENT,
      steps: { events: onTrigger({ on: { type: "mail", to: id }, body: perPr, onBodyFailure: "tolerate" }) },
    });
  };
}

/** The PR workflow with code review on Anthropic's models; the per-host definitions are in pr-workflow-github and pr-workflow-bitbucket-datacenter. */
export const prWorkflow = prWorkflowOf(agents);

/** The library definition the tests and evals run. */
export const workflow = prWorkflow({ sources: ["github"] });
