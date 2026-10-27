import type { EffectContext } from "@intx/workflow";
import { type } from "arktype";
import { JudgeVerdict, REPO_SOURCES } from "@corbits/triage-contracts";
import { answered, callHub, endRun, mailOf, tenantPath } from "@corbits/triage-manager/actions/hub";

/** The manager's mail to a judge it deployed: the rules output and the pull request. */
const JudgeMail = type({
  kind: "'judge'",
  tenantId: "string > 0",
  number: "number.integer > 0",
  checkout: { source: type.enumerated(...REPO_SOURCES), repo: "string > 0", sha: "string > 0" },
  rules: { items: "unknown[]", batch: "boolean", chunks: "unknown[]" },
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
 * finish; the hub then wakes the manager. The verdict goes whole, so the manager posts it as it was made. Posts nothing.
 */
export async function report(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ recorded: boolean }> {
  const parsed = ReportInput(input);
  if (parsed instanceof type.errors) throw new Error(`report: ${parsed.summary}`);
  const { tenantId, number, checkout } = judgeMailOf(parsed.payload).mail;
  const verdict = JudgeVerdict(parsed.evaluate?.output);
  const outcome = parsed.evaluate?.output === undefined || verdict instanceof type.errors ? { failed: NOT_FINISHED } : { result: verdict };
  const result = { source: checkout.source, repo: checkout.repo, number, kind: "judge" as const, head: checkout.sha, ...outcome };
  return answered(await callHub(ctx, "report", tenantPath(tenantId, "/manager/reviewer-result"), "POST", result), "report", Recorded);
}

/** Stops the judge's run once it has reported, whether or not the verdict or its report went through. */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const { mail, runId } = judgeMailOf(input);
  await endRun(ctx, mail.tenantId, runId);
  return { stopped: true };
}
