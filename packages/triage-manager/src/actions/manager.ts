import type { EffectContext } from "@intx/workflow";
import { type, type Type } from "arktype";
import { CodeReviewOutput, StageResult } from "@corbits/triage-contracts";
import { answered, callHub, endRun, pullRequestMailOf, tenantPath, type PullRequestMail } from "./hub.js";

export const Reviewer = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deadline: "string", "result?": "unknown" });
export type Reviewer = typeof Reviewer.infer;

const TakenEvent = type({ key: "string", event: { type: "string", head: "string", payload: "Record<string, unknown>" } });
const Taken = type({ outcome: "'idle'", reviewers: Reviewer.array() }).or({ outcome: "'pass'", pass: { head: "string" }, events: TakenEvent.array(), reviewers: Reviewer.array() });
const Done = type({ outcome: "'ended' | 'more'" });

export const TakeOutput = type({ taken: "boolean", "refused?": "true", request: "Record<string, unknown>", "head?": "string", "review?": CodeReviewOutput, reviewers: Reviewer.array() });
export type TakeOutput = typeof TakeOutput.infer;

/** Posts to the manager route as this run; undefined when the claim names another run, which then ends itself. */
async function asManager<T>(ctx: EffectContext, mail: PullRequestMail, route: "take" | "done", body: object, schema: Type<T>): Promise<T | undefined> {
  const answer = await callHub(ctx, route, tenantPath(mail.tenantId, `/manager/${route}`), "POST", body);
  if (answer.status !== 409) return answered(answer, route, schema);
  await endRun(ctx, mail.tenantId, mail.runId);
  return undefined;
}

/** The code review one of the manager's own reviewers reported on the pass's head. */
function reviewOf(events: (typeof TakenEvent.infer)[], head: string, reviewers: readonly Reviewer[]): CodeReviewOutput | undefined {
  for (const { key, event } of events) {
    const result = StageResult({ ...event.payload, head: event.head });
    if (result instanceof type.errors || result.kind !== "code-review") continue;
    if (reviewers.some((reviewer) => reviewer.kind === "code-review" && reviewer.head === head && key.endsWith(`:${reviewer.runId}`))) return result.result;
  }
  return undefined;
}

/**
 * Claims the pull request and takes its pending events, or its open pass again; `taken` is false when there is nothing
 * to do or another run is the manager. `review` is one of its code reviews' report on the pass's head, `reviewers` are
 * those the last done recorded, and `request` is the mail's, which stage 1 reads.
 */
export async function take(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<TakeOutput> {
  const mail = pullRequestMailOf(input);
  const answer = await asManager(ctx, mail, "take", mail.pullRequest, Taken);
  const { request } = mail;
  if (answer === undefined) return { taken: false, refused: true, request, reviewers: [] };
  if (answer.outcome === "idle") return { taken: false, request, reviewers: answer.reviewers };
  const { pass, events, reviewers } = answer;
  const review = reviewOf(events, pass.head, reviewers);
  return { taken: true, request, head: pass.head, ...(review && { review }), reviewers };
}

const DoneInput = type({ payload: "unknown", take: { output: TakeOutput }, "deployReview?": { output: { reviewer: Reviewer } } });

/** The reviewers to wait for: this head's, less a code review collected now, plus one deployed now. */
function reviewersAfter({ head, review, reviewers }: TakeOutput, deployed: Reviewer | undefined): Reviewer[] {
  const current = head === undefined ? reviewers : reviewers.filter((reviewer) => reviewer.head === head && !(review && reviewer.kind === "code-review"));
  return deployed ? [...current, deployed] : current;
}

/** Closes the pass; the run ends itself when the hub ends its claim. A run that take refused has ended already. */
export async function done(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ outcome: "ended" | "more" | "refused" }> {
  const parsed = DoneInput(input);
  if (parsed instanceof type.errors) throw new Error(`done: ${parsed.summary}`);
  if (parsed.take.output.refused) return { outcome: "refused" };
  const mail = pullRequestMailOf(parsed.payload);
  const answer = await asManager(ctx, mail, "done", { ...mail.pullRequest, reviewers: reviewersAfter(parsed.take.output, parsed.deployReview?.output.reviewer) }, Done);
  if (answer === undefined) return { outcome: "refused" };
  if (answer.outcome === "ended") await endRun(ctx, mail.tenantId, mail.runId);
  return answer;
}
