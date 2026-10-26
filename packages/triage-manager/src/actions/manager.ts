import type { EffectContext } from "@intx/workflow";
import { type, type Type } from "arktype";
import { APPROVE_DO_KIND, CodeReviewOutput, StageResult, WAITING_KIND } from "@corbits/triage-contracts";
import { answered, callHub, endRun, managerMailOf, tenantPath, type ManagerMail } from "./hub.js";

export const Reviewer = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deadline: "string", "result?": "unknown" });
export type Reviewer = typeof Reviewer.infer;

const TakenEvent = type({ key: "string", event: { type: "string", head: "string", payload: "Record<string, unknown>" } });
const Latest = { "request?": "Record<string, unknown>", reviewers: Reviewer.array() } as const;
const Taken = type({ outcome: "'idle'", ...Latest }).or({ outcome: "'pass'", pass: { head: "string" }, events: TakenEvent.array(), ...Latest });
const Done = type({ outcome: "'ended'" }).or({ outcome: "'more'", wait: "boolean" });

/**
 * What a pass works on. `run` when there is anything to do: a pass, or the code review the manager waits for is past
 * its deadline. `approvals` are the held Dos approved since, each run as pr-triage runs one. `triage` when the head is
 * triaged: `taken` is the newest pull request mail the hub recorded, or the mail that holds the head for CI when that
 * is the newest for it. `review` or `reviewFailed` is what one of its own code reviews reported on `head`.
 */
export const TakeOutput = type({
  run: "boolean",
  "refused?": "true",
  approvals: "Record<string, unknown>[]",
  triage: "boolean",
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
  const nothing = { run: false, approvals: [], triage: false, overdue: false };
  if (answer === undefined) return { ...nothing, refused: true, reviewers: [] };
  const { request, reviewers } = answer;
  const head = answer.outcome === "pass" ? answer.pass.head : request?.["headSha"];
  if (typeof head !== "string") return { ...nothing, reviewers };
  const events = answer.outcome === "pass" ? answer.events : [];
  const mails = events.filter(({ event }) => event.type === "webhook").map(({ event }) => event);
  const approvals = mails.filter((event) => event.payload["kind"] === APPROVE_DO_KIND).map((event) => event.payload);
  const forHead = mails.findLast((event) => event.head === head && event.payload["kind"] !== APPROVE_DO_KIND);
  const report = reportOf(events, head, reviewers);
  const overdue = !report.review && !report.reviewFailed && reviewers.some((reviewer) => isOwnReview(reviewer, head) && Date.parse(reviewer.deadline) <= Date.now());
  // A pass of approvals alone, before any pull request mail was recorded, has nothing to triage.
  const triage = request !== undefined && (forHead !== undefined || report.review !== undefined || report.reviewFailed !== undefined || overdue);
  const taken = forHead?.payload["kind"] === WAITING_KIND ? forHead.payload : request;
  return { run: answer.outcome === "pass" || overdue, approvals, triage, ...(taken && { taken }), head, ...report, overdue, reviewers };
}

const DoneInput = type({ payload: "unknown", take: { output: TakeOutput }, "reviewMailed?": { output: { "reviewer?": Reviewer } } });

/** The reviewers to wait for: this head's, less a code review that reported or ran out of time, plus one mailed now. */
function reviewersAfter({ head, review, reviewFailed, overdue, reviewers }: TakeOutput, mailed: Reviewer | undefined): Reviewer[] {
  const settled = review !== undefined || reviewFailed !== undefined || overdue;
  const current = head === undefined ? reviewers : reviewers.filter((reviewer) => reviewer.head === head && !(settled && reviewer.kind === "code-review"));
  return mailed ? [...current, mailed] : current;
}

/** The code reviews the pass stops waiting for without a report: one on an older head, or past its deadline. */
function abandoned({ head, overdue, reviewers }: TakeOutput): Reviewer[] {
  if (head === undefined) return [];
  return reviewers.filter((reviewer) => reviewer.kind === "code-review" && (reviewer.head !== head || overdue));
}

/**
 * Closes the pass and stops the code reviews it no longer waits for; the run ends itself when the hub ends its claim, and
 * a run that take refused has ended already. `more` runs the next pass at once, or with `wait` after waiting for a code
 * review.
 */
export async function done(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ outcome: "ended" | "refused" } | { outcome: "more"; wait: boolean }> {
  const parsed = DoneInput(input);
  if (parsed instanceof type.errors) throw new Error(`done: ${parsed.summary}`);
  if (parsed.take.output.refused) return { outcome: "refused" };
  const mail = managerMailOf(parsed.payload);
  const answer = await asManager(ctx, mail, "done", { ...mail.pullRequest, reviewers: reviewersAfter(parsed.take.output, parsed.reviewMailed?.output.reviewer) }, Done);
  if (answer === undefined) return { outcome: "refused" };
  for (const reviewer of abandoned(parsed.take.output)) await endRun(ctx, mail.tenantId, reviewer.runId);
  if (answer.outcome === "ended") await endRun(ctx, mail.tenantId, mail.runId);
  return answer;
}

/**
 * Stops the run when its passes fail or run out, so it never keeps the claim: the next manager's take finds the run gone
 * and claims the pull request.
 */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const mail = managerMailOf(input);
  await endRun(ctx, mail.tenantId, mail.runId);
  return { stopped: true };
}
