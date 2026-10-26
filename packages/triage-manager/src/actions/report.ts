import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { CodeReviewOutput, REPO_SOURCES } from "@corbits/triage-contracts";
import type { MailInput } from "../mail.js";
import { answered, callHub, endRun, mailOf, tenantPath } from "./hub.js";

/** The manager's mail to a code review it deployed: the review request, the tenant and the mail to reply with. */
const ReviewMail = type({
  kind: "'code-review'",
  tenantId: "string > 0",
  number: "number.integer > 0",
  checkout: { source: type.enumerated(...REPO_SOURCES), repo: "string > 0", sha: "string > 0" },
  reply: { to: "string > 0", content: "string > 0" },
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

const ReportInput = type({ payload: "unknown", review: { output: CodeReviewOutput } });
const Recorded = type({ recorded: "boolean" });

/** Reports the review to the pull request's manager as a `StageResult` through the hub; the reply then wakes the manager. Posts nothing. */
export async function report(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ recorded: boolean; mail: MailInput }> {
  const parsed = ReportInput(input);
  if (parsed instanceof type.errors) throw new Error(`report: ${parsed.summary}`);
  const { tenantId, number, checkout, reply } = reviewMailOf(parsed.payload).mail;
  const result = { source: checkout.source, repo: checkout.repo, number, kind: "code-review", head: checkout.sha, result: parsed.review.output };
  const { recorded } = answered(await callHub(ctx, "report", tenantPath(tenantId, "/manager/reviewer-result"), "POST", result), "report", Recorded);
  return { recorded, mail: { tenantId, ...reply, fresh: false } };
}

/** Stops the review's run once it has replied. */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const { mail, runId } = reviewMailOf(input);
  await endRun(ctx, mail.tenantId, runId);
  return { stopped: true };
}
