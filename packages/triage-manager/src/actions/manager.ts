import type { EffectContext } from "@intx/workflow";
import { type, type Type } from "arktype";
import { CodeReviewOutput, StageResult } from "@corbits/triage-contracts";
import { answered, callHub, endRun, managerMailOf, tenantPath, type ManagerMail } from "./hub.js";

export const Reviewer = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deadline: "string", "result?": "unknown" });
export type Reviewer = typeof Reviewer.infer;

const TakenEvent = type({ key: "string", event: { type: "string", head: "string", payload: "Record<string, unknown>" } });
const Latest = { "request?": "Record<string, unknown>", reviewers: Reviewer.array() } as const;
const Taken = type({ outcome: "'idle'", ...Latest }).or({ outcome: "'pass'", pass: { head: "string" }, events: TakenEvent.array(), ...Latest });
const Done = type({ outcome: "'ended'" }).or({ outcome: "'more'", wait: "boolean" });

/**
 * What a pass works on. `run` when there is anything to do: a pass, or the code review the manager waits for is past
 * its deadline. `taken` is the newest pull request mail the hub recorded, which the pass's steps read; `review` or
 * `reviewFailed` is what one of its own code reviews reported on `head`.
 */
export const TakeOutput = type({
  run: "boolean",
  "refused?": "true",
  "taken?": "Record<string, unknown>",
  "head?": "string",
  "review?": CodeReviewOutput,
  "reviewFailed?": "string",
  overdue: "boolean",
  reviewers: Reviewer.array(),
});
export type TakeOutput = typeof TakeOutput.infer;

/** Posts to the manager route as this run; undefined when the claim names another run, which then ends itself. */
async function asManager<T>(ctx: EffectContext, mail: ManagerMail, route: "take" | "done", body: object, schema: Type<T>): Promise<T | undefined> {
  const answer = await callHub(ctx, route, tenantPath(mail.tenantId, `/manager/${route}`), "POST", body);
  if (answer.status !== 409) return answered(answer, route, schema);
  await endRun(ctx, mail.tenantId, mail.runId);
  return undefined;
}

function isOwnReview(reviewer: Reviewer, head: string): boolean {
  return reviewer.kind === "code-review" && reviewer.head === head;
}

/** What one of the manager's own code reviews reported on `head`. */
function reportOf(events: (typeof TakenEvent.infer)[], head: string, reviewers: readonly Reviewer[]): Pick<TakeOutput, "review" | "reviewFailed"> {
  for (const { key, event } of events) {
    const result = StageResult({ ...event.payload, head: event.head });
    if (result instanceof type.errors || result.kind !== "code-review") continue;
    if (!reviewers.some((reviewer) => isOwnReview(reviewer, head) && key.endsWith(`:${reviewer.runId}`))) continue;
    return "failed" in result ? { reviewFailed: result.failed } : { review: result.result };
  }
  return {};
}

/** Claims the pull request and takes its pending events, or its open pass again; see `TakeOutput`. */
export async function take(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<TakeOutput> {
  const mail = managerMailOf(input);
  const answer = await asManager(ctx, mail, "take", mail.pullRequest, Taken);
  if (answer === undefined) return { run: false, refused: true, overdue: false, reviewers: [] };
  const { request, reviewers } = answer;
  const head = answer.outcome === "pass" ? answer.pass.head : request?.["headSha"];
  if (!request || typeof head !== "string") return { run: false, overdue: false, reviewers };
  const report = answer.outcome === "pass" ? reportOf(answer.events, head, reviewers) : {};
  const overdue = !report.review && !report.reviewFailed && reviewers.some((reviewer) => isOwnReview(reviewer, head) && Date.parse(reviewer.deadline) <= Date.now());
  return { run: answer.outcome === "pass" || overdue, taken: request, head, ...report, overdue, reviewers };
}

const DoneInput = type({ payload: "unknown", take: { output: TakeOutput }, "reviewMailed?": { output: { "reviewer?": Reviewer } } });

/** The reviewers to wait for: this head's, less a code review that reported or ran out of time, plus one mailed now. */
function reviewersAfter({ head, review, reviewFailed, overdue, reviewers }: TakeOutput, mailed: Reviewer | undefined): Reviewer[] {
  const settled = review !== undefined || reviewFailed !== undefined || overdue;
  const current = head === undefined ? reviewers : reviewers.filter((reviewer) => reviewer.head === head && !(settled && reviewer.kind === "code-review"));
  return mailed ? [...current, mailed] : current;
}

/**
 * Closes the pass; the run ends itself when the hub ends its claim, and a run that take refused has ended already.
 * `more` runs the next pass at once, or with `wait` after waiting for a code review.
 */
export async function done(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ outcome: "ended" | "refused" } | { outcome: "more"; wait: boolean }> {
  const parsed = DoneInput(input);
  if (parsed instanceof type.errors) throw new Error(`done: ${parsed.summary}`);
  if (parsed.take.output.refused) return { outcome: "refused" };
  const mail = managerMailOf(parsed.payload);
  const answer = await asManager(ctx, mail, "done", { ...mail.pullRequest, reviewers: reviewersAfter(parsed.take.output, parsed.reviewMailed?.output.reviewer) }, Done);
  if (answer === undefined) return { outcome: "refused" };
  if (answer.outcome === "ended") await endRun(ctx, mail.tenantId, mail.runId);
  return answer;
}

/** The loop runs out of passes; the claim stays live, and the next mail runs more. */
export async function rest(): Promise<{ rested: true }> {
  return { rested: true };
}
