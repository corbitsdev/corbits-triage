import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { REPO_SOURCES, VerdictDetail } from "@corbits/triage-contracts";
import type { MailInput } from "@corbits/triage-manager/mail";
import { answered, callHub, endRun, mailOf, tenantPath } from "@corbits/triage-manager/actions/hub";

/** The manager's mail to a judge it deployed: the rules output, the pull request and the mail to reply with. */
const JudgeMail = type({
  kind: "'judge'",
  tenantId: "string > 0",
  number: "number.integer > 0",
  checkout: { source: type.enumerated(...REPO_SOURCES), repo: "string > 0", sha: "string > 0" },
  rules: { items: "unknown[]", batch: "boolean", chunks: "unknown[]" },
  reply: { to: "string > 0", content: "string > 0" },
});

function judgeMailOf(payload: unknown) {
  const { request, runId } = mailOf(payload);
  const mail = JudgeMail(request);
  if (mail instanceof type.errors) throw new Error(`the judge mail: ${mail.summary}`);
  return { mail, runId };
}

/** The rules output the manager mailed, which the judge's steps read as pr-triage's rules step left it. */
export async function judgeRequest(input: unknown): Promise<{ items: unknown[]; batch: boolean; chunks: unknown[] }> {
  return judgeMailOf(input).mail.rules;
}

const ReportInput = type({ payload: "unknown", "evaluate?": { output: "unknown" } });
const Recorded = type({ recorded: "boolean" });

/** Stock runs a step whose dependencies failed, so a judge that did not finish leaves no output, or one that is not a verdict. */
const NOT_FINISHED = "the judge did not finish";

/**
 * Reports the verdict to the pull request's manager as a `StageResult` through the hub, or that the judge did not
 * finish; the reply then wakes the manager. The verdict keeps the answers a later pass replays. Posts nothing.
 */
export async function report(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ recorded: boolean; mail: MailInput }> {
  const parsed = ReportInput(input);
  if (parsed instanceof type.errors) throw new Error(`report: ${parsed.summary}`);
  const { tenantId, number, checkout, reply } = judgeMailOf(parsed.payload).mail;
  const verdict = VerdictDetail(parsed.evaluate?.output);
  const outcome = parsed.evaluate?.output === undefined || verdict instanceof type.errors ? { failed: NOT_FINISHED } : { result: verdict };
  const result = { source: checkout.source, repo: checkout.repo, number, kind: "judge" as const, head: checkout.sha, ...outcome };
  const { recorded } = answered(await callHub(ctx, "report", tenantPath(tenantId, "/manager/reviewer-result"), "POST", result), "report", Recorded);
  return { recorded, mail: { tenantId, ...reply } };
}

/** Stops the judge's run once it has replied, whether or not the verdict, its report or its reply went through. */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const { mail, runId } = judgeMailOf(input);
  await endRun(ctx, mail.tenantId, runId);
  return { stopped: true };
}
