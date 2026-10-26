import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { repoSourceOf, RULE_GATES, rulesGate } from "@corbits/triage-contracts";
import { call, hostWrite, toolName } from "@corbits/triage-workflows/logic/host";
import { codeReviewSummary } from "@corbits/triage-workflows/logic/render";
import type { MailInput } from "../mail.js";
import { Release } from "../release.js";
import { deploy, pullRequestMailOf } from "./hub.js";
import { TakeOutput, type Reviewer } from "./manager.js";

/** How long the manager waits for a code review it deployed before its claim may end without it. */
const REVIEW_DEADLINE_MS = 60 * 60_000;

const CodeReviewPart = type({ on: "boolean", rules: type.enumerated(...RULE_GATES) });
const ScopeInput = type({ payload: "unknown", take: { output: TakeOutput }, evaluateRules: { output: "unknown" } });

/**
 * Whether the pass deploys code review, and whether it posts. Code review runs once per head, when the policy turns it on
 * and triage's rules let it past as its `when.rules` says; the pass that deploys it, and any before its review is in,
 * post nothing, so the verdict and the review go up together.
 */
export async function reviewScope(input: unknown): Promise<{ deploy: boolean; post: boolean }> {
  const parsed = ScopeInput(input);
  if (parsed instanceof type.errors) throw new Error(`reviewScope: ${parsed.summary}`);
  const { request } = pullRequestMailOf(parsed.payload);
  const part = CodeReviewPart(request["codeReview"]);
  const { head, review, reviewers } = parsed.take.output;
  const reviewed = !(part instanceof type.errors) && part.on && rulesGate(part.rules, asRecord(parsed.evaluateRules.output)?.["checks"]).open;
  if (!reviewed || review) return { deploy: false, post: true };
  const pending = reviewers.some((reviewer) => reviewer.kind === "code-review" && reviewer.head === head);
  return { deploy: !pending && request["codeReviewRequest"] !== undefined, post: false };
}

const DeployInput = type({ release: Release, payload: "unknown", take: { output: TakeOutput } });

/** Deploys code review from the release; it is mailed the head's review request and the mail to reply to this run with. */
export async function deployReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ reviewer: Reviewer; mail: MailInput }> {
  const parsed = DeployInput(input);
  if (parsed instanceof type.errors) throw new Error(`deployReview: ${parsed.summary}`);
  const { tenantId, runId, request } = pullRequestMailOf(parsed.payload);
  const { head } = parsed.take.output;
  if (head === undefined) throw new Error("deployReview: the pass names no head");
  const reviewRun = await deploy(ctx, tenantId, parsed.release);
  const reply = { to: runId, content: JSON.stringify(request) };
  const content = JSON.stringify({ ...asRecord(request["codeReviewRequest"]), tenantId, reply });
  return {
    reviewer: { kind: "code-review", head, runId: reviewRun, deadline: new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString() },
    mail: { tenantId, to: reviewRun, content, fresh: true },
  };
}

const PostInput = type({ payload: "unknown", take: { output: TakeOutput } });

/** Posts the code review the pass collected on its head, after the verdict; the host writes nothing for a review already there. */
export async function postReview(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ posted: boolean }> {
  const parsed = PostInput(input);
  if (parsed instanceof type.errors) throw new Error(`postReview: ${parsed.summary}`);
  const { review, head } = parsed.take.output;
  if (!review || head === undefined) return { posted: false };
  const summary = codeReviewSummary(review);
  if (!summary && review.comments.length === 0) return { posted: false };
  const { pullRequest, request } = pullRequestMailOf(parsed.payload);
  const source = repoSourceOf(pullRequest.source);
  const args = { repo: pullRequest.repo, number: pullRequest.number, sha: head, summary, comments: review.comments, appLogin: request["appLogin"] };
  const result = await hostWrite(ctx)(source, call(toolName(source, "send_code_review"), args, `review:${head}`));
  if (result.isError) throw new Error(`postReview: ${JSON.stringify(result.content)}`);
  return { posted: true };
}
