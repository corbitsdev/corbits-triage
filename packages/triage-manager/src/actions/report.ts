import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { CodeReviewOutput, REPO_SOURCES } from "@corbits/triage-contracts";
import { answered, callHub, endRun, mailOf, tenantPath } from "./hub.js";

/** The manager's mail to a code review it deployed: the review request and the tenant. */
const ReviewMail = type({
  kind: "'code-review'",
  tenantId: "string > 0",
  number: "number.integer > 0",
  checkout: { source: type.enumerated(...REPO_SOURCES), repo: "string > 0", sha: "string > 0" },
  "diffHash?": "string > 0",
});

function reviewMailOf(payload: unknown) {
  const { request, runId } = mailOf(payload);
  const mail = ReviewMail(request);
  if (mail instanceof type.errors) throw new Error(`the review mail: ${mail.summary}`);
  return { request, mail, runId };
}

/** The review request the manager's mail carries, handed over to the review's steps. */
export async function reviewRequest(input: unknown): Promise<{ request: Record<string, unknown> }> {
  return { request: reviewMailOf(input).request };
}

const ReportInput = type({ payload: "unknown", "review?": { output: "unknown" } });
const Recorded = type({ recorded: "boolean" });

/** Stock runs a step whose dependencies failed, so a review that did not finish leaves no output, or one that is not a review. */
const NOT_FINISHED = "the review did not finish";

/**
 * Reports the review to the pull request's manager as a `StageResult` through the hub, or that it did not finish; the
 * hub then wakes the manager. Posts nothing. Its input is every step's output beside the mail.
 */
export async function report(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ recorded: boolean }> {
  const parsed = ReportInput(input);
  if (parsed instanceof type.errors) throw new Error(`report: ${parsed.summary}`);
  const { tenantId, number, checkout, diffHash } = reviewMailOf(parsed.payload).mail;
  const review = CodeReviewOutput(parsed.review?.output);
  const outcome = review instanceof type.errors ? { failed: NOT_FINISHED } : { result: review, ...(diffHash && { diffHash }) };
  const result = { source: checkout.source, repo: checkout.repo, number, kind: "code-review", head: checkout.sha, ...outcome };
  return answered(await callHub(ctx, "report", tenantPath(tenantId, "/manager/reviewer-result"), "POST", result), "report", Recorded);
}

/** Stops the review's run once it has reported, whether or not the review or its report went through. */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const { mail, runId } = reviewMailOf(input);
  await endRun(ctx, mail.tenantId, runId);
  return { stopped: true };
}
