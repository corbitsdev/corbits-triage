import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { CodeReviewOutput, repoSourceOf, RULE_GATES, rulesGate } from "@corbits/triage-contracts";
import { call, hostWrite, toolName } from "@corbits/triage-workflows/logic/host";
import { codeReviewSummary } from "@corbits/triage-workflows/logic/render";
import { Mailed, type MailInput } from "../mail.js";
import { publishedFor } from "../release.js";
import { deploy, managerMailOf, manageMail } from "./hub.js";
import { Reviewer, TakeOutput } from "./manager.js";

/** How long the manager waits for a code review it deployed, from its deploy to its report. */
export const REVIEW_DEADLINE_MS = 60 * 60_000;

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES) });
const ScopeInput = type({ payload: "unknown", take: { output: TakeOutput }, evaluateRules: { output: "unknown" } });

/**
 * Whether the pass deploys code review, and whether it posts. Code review runs once per head, when the policy turns it on,
 * triage's rules let it past as its `when.rules` says, the hub read the head's review request and the release publishes
 * a code review for the host. The pass that deploys
 * it, and every pass before its review is in, posts nothing, so the verdict and the review go up together; one that
 * reported a failure or ran past its deadline posts the verdict alone. A later pass on a head whose review settled posts
 * again and deploys no other.
 */
export async function reviewScope(input: unknown): Promise<{ deploy: boolean; post: boolean; reviewed: boolean }> {
  const parsed = ScopeInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewScope: ${parsed.summary}`);
  const { taken, head, review, reviewFailed, reviewers } = parsed.take.output;
  const part = CodeReviewPart(taken?.["codeReview"]);
  const reviewed = !(part instanceof type.errors) && part.on && rulesGate(part.rules, asRecord(parsed.evaluateRules.output)?.["checks"]).open;
  const published = publishedFor(repoSourceOf(managerMailOf(parsed.payload).pullRequest.source), "codeReview") !== undefined;
  const own = reviewers.filter((reviewer) => reviewer.kind === "code-review" && reviewer.head === head);
  const settled = own.some((reviewer) => reviewer.result !== undefined || Date.parse(reviewer.deadline) <= Date.now());
  if (!reviewed || !published || review || reviewFailed || settled || taken?.["codeReviewRequest"] === undefined) return { deploy: false, post: true, reviewed };
  return { deploy: own.length === 0, post: false, reviewed };
}

const DeployInput = type({ payload: "unknown", take: { output: TakeOutput } });

/**
 * Deploys code review from the host's published release; it is mailed the head's review request and, to reply with, the mail that wakes
 * this manager. The mail waits for the new run until the review's deadline.
 */
export async function deployReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ reviewer: Reviewer; mail: MailInput }> {
  const parsed = DeployInput(input);
  if (parsed instanceof type.errors) throw new Error(`deployReview: ${parsed.summary}`);
  const { tenantId, runId, pullRequest } = managerMailOf(parsed.payload);
  const { head, taken } = parsed.take.output;
  if (head === undefined || !taken) throw new Error("deployReview: the pass names no head");
  const release = publishedFor(repoSourceOf(pullRequest.source), "codeReview");
  if (!release) throw new Error("deployReview: release.json publishes no code review for the host");
  const reviewRun = await deploy(ctx, "deploy", tenantId, release);
  const deadline = new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString();
  const content = JSON.stringify({ ...asRecord(taken["codeReviewRequest"]), tenantId, reply: { to: runId, content: manageMail(tenantId, pullRequest) } });
  return { reviewer: { kind: "code-review", head, runId: reviewRun, deployedBy: runId, deadline }, mail: { tenantId, to: reviewRun, content, readyBy: deadline } };
}

const MailedInput = type({ deployReview: { output: { reviewer: Reviewer } }, mailReview: { output: { reply: "string" } } });

/**
 * The review becomes a reviewer to wait for once its mail went. A mail that failed by its deadline leaves the pass to
 * post the verdict without code review.
 */
export async function reviewMailed(input: unknown): Promise<{ reviewer?: Reviewer; post: boolean }> {
  const parsed = MailedInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewMailed: ${parsed.summary}`);
  const mailed = Mailed(parsed.mailReview.output.reply);
  if (mailed instanceof type.errors) throw new Error(`reviewMailed: ${mailed.summary}`);
  return mailed.mailed ? { reviewer: parsed.deployReview.output.reviewer, post: false } : { post: true };
}

const PostInput = type({ payload: "unknown", take: { output: TakeOutput }, reviewScope: { output: { reviewed: "boolean" } } });

/** The review a code review of `head` reported on an earlier pass, stored on its reviewer. */
function storedReview(reviewers: readonly Reviewer[], head: string): CodeReviewOutput | undefined {
  for (const reviewer of reviewers) {
    if (reviewer.kind !== "code-review" || reviewer.head !== head) continue;
    const review = CodeReviewOutput(reviewer.result);
    if (!(review instanceof type.errors)) return review;
  }
  return undefined;
}

/**
 * Posts the code review reported on its head after the verdict: this pass's, or one an earlier pass stored when this
 * pass's rules still let code review past. The host writes nothing for a review already there.
 */
export async function postReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ posted: boolean }> {
  const parsed = PostInput(input);
  if (parsed instanceof type.errors) throw new Error(`postReview: ${parsed.summary}`);
  const { head, taken, reviewers } = parsed.take.output;
  if (head === undefined || !taken) return { posted: false };
  const review = parsed.take.output.review ?? (parsed.reviewScope.output.reviewed ? storedReview(reviewers, head) : undefined);
  if (!review) return { posted: false };
  const summary = codeReviewSummary(review);
  if (!summary && review.comments.length === 0) return { posted: false };
  const { pullRequest } = managerMailOf(parsed.payload);
  const source = repoSourceOf(pullRequest.source);
  const args = { repo: pullRequest.repo, number: pullRequest.number, sha: head, summary, comments: review.comments, appLogin: taken["appLogin"] };
  const result = await hostWrite(ctx)(source, call(toolName(source, "send_code_review"), args, `review:${head}`));
  if (result.isError) throw new Error(`postReview: ${JSON.stringify(result.content)}`);
  return { posted: true };
}
