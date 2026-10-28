import type { EffectContext } from "@intx/workflow";
import { type, type Type } from "arktype";
import { APPROVE_DO_KIND, CI_START_MS, CI_WAIT_MS, CodeReviewOutput, JudgeVerdict, StageResult, VerdictFacts } from "@corbits/triage-contracts";
import type { Item } from "@corbits/triage-workflows/logic/item";
import { hostAwaited, type Awaits } from "@corbits/triage-workflows/logic/render";
import { decided } from "@corbits/triage-workflows/logic/settled";
import { answered, callHub, endRun, managerMailOf, tenantPath, type ManagerMail } from "./hub.js";

/** `again` names the Review again a code review was deployed for. */
export const Reviewer = type({ kind: "string > 0", head: "string > 0", runId: "string > 0", deployedBy: "string > 0", deadline: "string", "again?": "string > 0", "result?": "unknown" });
export type Reviewer = typeof Reviewer.infer;

const TakenEvent = type({ key: "string", event: { type: "string", head: "string", payload: "Record<string, unknown>" } });
const Latest = { "request?": "Record<string, unknown>", reviewers: Reviewer.array(), "waitingSince?": "string", "headSince?": "string", claimedAt: "string" } as const;
const Taken = type({ outcome: "'idle'", ...Latest }).or({ outcome: "'pass'", pass: { head: "string" }, events: TakenEvent.array(), ...Latest });
const Done = type({ outcome: "'ended'" }).or({ outcome: "'more'", wait: "boolean" });

/**
 * How long a manager lives from claiming its pull request, time for the judge and code review to each take their hour
 * with CI in between; a new head does not extend it. A manager ends while it waits only on CI, so this bounds one its
 * reviewers keep alive.
 */
export const LIFETIME_MS = 3 * 60 * 60_000;

/**
 * What a pass works on. `run` when there is anything to do: a pass, a reviewer the manager waits for is past its
 * deadline, or its head waited out its CI. `approvals` are the held Dos approved since, each run as pr-triage runs one.
 * `triage` when the head is triaged: `taken` is the newest pull request mail the hub recorded, deciding without the
 * host's checks once the head waited out its CI, and as `ciStarting` while a head with no checks yet may still get some. `review` or `reviewFailed`, and `judge` or `judgeFailed`, is what one
 * of its own reviewers reported on `head` on this pass; `verdict` is the judge's verdict on `head`, reported on this
 * pass or an earlier one. `waitingSince` is when the head started waiting for its CI, while it still does. `stopped`
 * names what the head still waited for once the manager's lifetime ran out: the pass decides without it.
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
  "judge?": JudgeVerdict,
  "judgeFailed?": "string",
  "verdict?": JudgeVerdict,
  overdue: "boolean",
  reviewers: Reviewer.array(),
  "waitingSince?": "string",
  "stopped?": type.enumerated("ci", "judge", "code-review").array(),
});
export type TakeOutput = typeof TakeOutput.infer;

/** Posts to the manager route as this run; undefined when the claim names another run. */
async function asManager<T>(ctx: EffectContext, mail: ManagerMail, route: "take" | "done", body: object, schema: Type<T>): Promise<T | undefined> {
  const answer = await callHub(ctx, route, tenantPath(mail.tenantId, `/manager/${route}`), "POST", body);
  if (answer.status !== 409) return answered(answer, route, schema);
  return undefined;
}

function isOwn(reviewer: Reviewer, kind: string, head: string): boolean {
  return reviewer.kind === kind && reviewer.head === head;
}

/** The newest review a code review of `head` reported on an earlier pass, stored on its reviewer: after a Review again, its own. */
export function storedReview(reviewers: readonly Reviewer[], head: string): CodeReviewOutput | undefined {
  let newest: { review: CodeReviewOutput; deadline: number } | undefined;
  for (const reviewer of reviewers) {
    if (!isOwn(reviewer, "code-review", head)) continue;
    const review = CodeReviewOutput(reviewer.result);
    const deadline = Date.parse(reviewer.deadline);
    if (!(review instanceof type.errors) && (newest === undefined || deadline >= newest.deadline)) newest = { review, deadline };
  }
  return newest?.review;
}

/** A judge whose evaluate could not read the pull request reports a verdict that names no head, which decides nothing. */
const NO_HEAD = "the judge's verdict names no head";

/** What one of the manager's own reviewers reported on `head`. */
function reportOf(events: (typeof TakenEvent.infer)[], head: string, reviewers: readonly Reviewer[]): Pick<TakeOutput, "review" | "reviewFailed" | "judge" | "judgeFailed"> {
  const reported: Pick<TakeOutput, "review" | "reviewFailed" | "judge" | "judgeFailed"> = {};
  for (const { key, event } of events) {
    const result = StageResult({ ...event.payload, head: event.head });
    if (result instanceof type.errors) continue;
    if (!reviewers.some((reviewer) => isOwn(reviewer, result.kind, head) && key.endsWith(`:${reviewer.runId}`))) continue;
    if (result.kind === "code-review") {
      if ("failed" in result) reported.reviewFailed = result.failed;
      else reported.review = result.result;
    } else if ("failed" in result) reported.judgeFailed = result.failed;
    else if (result.result.headSha === null) reported.judgeFailed = NO_HEAD;
    else reported.judge = result.result;
  }
  return reported;
}

/** The decided verdict a judge of `head` reported on an earlier pass, stored on its reviewer. */
function storedVerdict(reviewers: readonly Reviewer[], head: string): JudgeVerdict | undefined {
  for (const reviewer of reviewers) {
    if (reviewer.kind !== "judge" || reviewer.head !== head) continue;
    const verdict = JudgeVerdict(reviewer.result);
    if (!(verdict instanceof type.errors) && decided(verdict, head)) return verdict;
  }
  return undefined;
}

/** A reviewer of `kind` on `head` whose deadline passed with no report and no result stored. */
function late(reviewers: readonly Reviewer[], head: string, kind: string, reported: boolean): boolean {
  return !reported && reviewers.some((reviewer) => isOwn(reviewer, kind, head) && reviewer.result === undefined && Date.parse(reviewer.deadline) <= Date.now());
}

/** Whether an item's facts show the host has still to settle what its policy reads; its judge is held until then. */
export function waitingOnHost(items: readonly object[]): boolean {
  return (items as Item[]).some((item) => hostAwaited(item) !== undefined);
}

/** What `head` still waits for: its CI, or a judge or code review of it with no result and no report on this pass. */
function stillAwaited(reviewers: readonly Reviewer[], head: string, waitingSince: string | undefined, report: ReturnType<typeof reportOf>): Awaits[] {
  const reported = { judge: report.judge !== undefined || report.judgeFailed !== undefined, "code-review": report.review !== undefined || report.reviewFailed !== undefined };
  function out(kind: "judge" | "code-review"): boolean {
    return !reported[kind] && reviewers.some((reviewer) => isOwn(reviewer, kind, head) && reviewer.result === undefined);
  }
  return [...(waitingSince !== undefined ? ["ci" as const] : []), ...(["judge", "code-review"] as const).filter(out)];
}

/** Claims the pull request and takes its pending events, or its open pass again; see `TakeOutput`. */
export async function take(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<TakeOutput> {
  const mail = managerMailOf(input);
  const answer = await asManager(ctx, mail, "take", mail.pullRequest, Taken);
  const nothing = { run: false, approvals: [], triage: false, overdue: false };
  if (answer === undefined) return { ...nothing, refused: true, reviewers: [] };
  const { request, waitingSince, headSince, claimedAt } = answer;
  const head = answer.outcome === "pass" ? answer.pass.head : request?.["headSha"];
  if (typeof head !== "string") return { ...nothing, reviewers: answer.reviewers };
  const events = answer.outcome === "pass" ? answer.events : [];
  const mails = events.filter(({ event }) => event.type === "webhook").map(({ event }) => event);
  const approvals = mails.filter((event) => event.payload["kind"] === APPROVE_DO_KIND).map((event) => event.payload);
  const forHead = mails.findLast((event) => event.head === head && event.payload["kind"] !== APPROVE_DO_KIND);
  const outstanding = Date.now() - Date.parse(claimedAt) >= LIFETIME_MS ? stillAwaited(answer.reviewers, head, waitingSince, reportOf(events, head, answer.reviewers)) : [];
  const stopped = outstanding.length > 0;
  // A manager out of time takes every reviewer it still waits for as past its deadline, so the pass decides without it.
  const now = new Date().toISOString();
  const reviewers = stopped ? answer.reviewers.map((reviewer) => (reviewer.head === head && reviewer.result === undefined ? { ...reviewer, deadline: now } : reviewer)) : answer.reviewers;
  const report = reportOf(events, head, reviewers);
  const overdue = late(reviewers, head, "code-review", report.review !== undefined || report.reviewFailed !== undefined) || late(reviewers, head, "judge", report.judge !== undefined || report.judgeFailed !== undefined);
  const waited = waitingSince === undefined ? undefined : Date.now() - Date.parse(waitingSince);
  const waitedOut = stopped || (waited !== undefined && waited >= CI_WAIT_MS);
  // A pass of approvals alone, before any pull request mail was recorded, has nothing to triage.
  const triage = request !== undefined && (forHead !== undefined || report.review !== undefined || report.reviewFailed !== undefined || report.judge !== undefined || report.judgeFailed !== undefined || overdue || waitedOut);
  const starting = headSince === undefined || Date.now() - Date.parse(headSince) < CI_START_MS;
  const taken = request && { ...request, ...(waitedOut && { noWait: true }), ...(!waitedOut && starting && { ciStarting: true }) };
  const verdict = report.judge ?? storedVerdict(reviewers, head);
  const waiting = waitingSince !== undefined && !waitedOut;
  return { run: answer.outcome === "pass" || overdue || waitedOut, approvals, triage, ...(taken && { taken }), head, ...report, ...(verdict && { verdict }), overdue, reviewers, ...(waiting && { waitingSince }), ...(stopped && { stopped: outstanding }) };
}

const Output = { output: "Record<string, unknown>" } as const;

const DoneInput = type({
  payload: "unknown",
  take: { output: TakeOutput },
  "approvals?": { output: { results: "Record<string, unknown>[]" } },
  "rules?": { output: { items: type({ facts: "Record<string, unknown>", "det?": "unknown" }).array() } },
  "cleared?": Output,
  "reviewScope?": { output: { "skipped?": "string" } },
  "mirrorRules?": Output,
  "executeRules?": Output,
  "reviewMailed?": { output: { "reviewer?": Reviewer } },
  "earlyReviewMailed?": { output: { "reviewer?": Reviewer } },
  "judgeMailed?": { output: { "reviewer?": Reviewer } },
});

type DoneInput = typeof DoneInput.infer;

/** The rules' reasons, which a verdict that gives none of its own keeps as its evidence. */
const RuledReasons = type({ "+": "delete", "reason?": "string", "findings?": type({ "+": "delete", "reason?": "string" }).array() });

/**
 * What the pass did on its head, for the hub to record: triaged it with a reviewer still out, or posted the verdict its
 * mirror ran on, with why the policy left code review out, and only the facts and reasons the verdict keeps, never the
 * diff. A pass that triaged nothing reports nothing.
 */
function doneReport({ take, rules, cleared, reviewScope, mirrorRules, executeRules }: DoneInput): Record<string, unknown> | undefined {
  const { head } = take.output;
  if (head === undefined || !rules) return undefined;
  // A reviewer is out, so nothing was posted; a head whose facts show CI still awaited keeps its CI wait running.
  if (!cleared || !mirrorRules) return { head, ...(waitingOnHost(rules.output.items) && { waiting: true }) };
  const items = rules.output.items.map(({ facts, det }) => ({ facts: { ...VerdictFacts.assert(facts), repo: facts["repo"], number: facts["number"] }, ...(det !== undefined && { det: RuledReasons.assert(det) }) }));
  const skipped = reviewScope?.output.skipped;
  const verdict = skipped === undefined ? cleared.output : { ...cleared.output, codeReviewSkipped: skipped };
  return { head, verdict, mirror: mirrorRules.output, ...(executeRules && { executed: executeRules.output }), rules: { items } };
}

/** This pass's report, or a passed deadline, recorded on the reviewer it belongs to. */
function remembered(take: TakeOutput): Reviewer[] {
  const { head, reviewers } = take;
  const current = head === undefined ? [...reviewers] : reviewers.filter((reviewer) => reviewer.head === head);
  return current.map(function attach(reviewer) {
    if (reviewer.result !== undefined) return reviewer;
    if (reviewer.kind === "code-review" && reviewer.head === head) {
      if (take.review) return { ...reviewer, result: take.review };
      if (take.reviewFailed) return { ...reviewer, result: { failed: take.reviewFailed } };
    }
    if (reviewer.kind === "judge" && reviewer.head === head) {
      if (take.judge) return { ...reviewer, result: take.judge };
      if (take.judgeFailed) return { ...reviewer, result: { failed: take.judgeFailed } };
    }
    if (take.overdue && Date.parse(reviewer.deadline) <= Date.now()) return { ...reviewer, result: { failed: "overdue" } };
    return reviewer;
  });
}

/** The most one stored result takes of done's body, which the route caps at 1 MiB and holds a judge's and a review's. */
const MAX_STORED_BYTES = 256 * 1024;

function storable(reviewer: Reviewer): boolean {
  return reviewer.result === undefined || Buffer.byteLength(JSON.stringify(reviewer.result)) <= MAX_STORED_BYTES;
}

/** A result a later pass on `head` posts as it is: a decided verdict, or a code review. */
function lasting(reviewer: Reviewer, head: string): boolean {
  if (reviewer.kind === "code-review") return !(CodeReviewOutput(reviewer.result) instanceof type.errors);
  const verdict = JudgeVerdict(reviewer.result);
  return reviewer.kind === "judge" && !(verdict instanceof type.errors) && decided(verdict, head);
}

/**
 * The reviewers to wait for. A result stays on its reviewer while another of this head is still out, so a judge that
 * reported before code review is not lost. Once nothing is waiting, only the lasting results of the pass's head stay, so
 * a later pass on it posts them and deploys no other; a degraded, undecided, failed or late one is dropped, so the next
 * event deploys its reviewer again. A result too large to store is dropped. Plus one mailed now.
 */
function reviewersAfter(take: TakeOutput, mailed: readonly Reviewer[]): Reviewer[] {
  const { head } = take;
  let current = remembered(take).filter(storable);
  const waiting = current.some((reviewer) => reviewer.result === undefined) || mailed.some((reviewer) => reviewer.result === undefined);
  if (!waiting) current = current.filter((reviewer) => reviewer.result === undefined || (head !== undefined && lasting(reviewer, head)));
  return [...current, ...mailed];
}

/**
 * The reviewers of the pass's head this run deployed that ran past their deadline with no report. The hub stops one on
 * an older head when it records the newer one; one an earlier manager deployed runs out on its own, since only its
 * deployer may stop it.
 */
function abandoned({ head, reviewers }: TakeOutput, runId: string): Reviewer[] {
  return reviewers.filter((reviewer) => reviewer.deployedBy === runId && reviewer.head === head && reviewer.result === undefined && Date.parse(reviewer.deadline) <= Date.now());
}

/**
 * Whether the pass's head still waits for a reviewer of its own, out and within its deadline, whose result comes to this
 * manager. A head that waits only on the host's checks does not keep it: the next host event, or the reconciler once
 * CI settles, wakes a manager for it.
 */
function awaiting(take: TakeOutput, reviewers: readonly Reviewer[]): boolean {
  if (take.stopped) return false;
  return reviewers.some((reviewer) => reviewer.head === take.head && reviewer.result === undefined && Date.parse(reviewer.deadline) > Date.now());
}

/**
 * Closes the pass with what it ran and stops the reviewers it no longer waits for. A pass whose head still awaits a
 * reviewer asks the hub to `wait`. `more` runs the next pass at once, or with `wait` after polling for the reviewer;
 * `ended` ends the run once the head has its final verdict or waits only on CI, and a later event starts the next one.
 */
export async function done(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ outcome: "ended" | "refused" } | { outcome: "more"; wait: boolean }> {
  const parsed = DoneInput(input);
  if (parsed instanceof type.errors) throw new Error(`done: ${parsed.summary}`);
  if (parsed.take.output.refused) return { outcome: "refused" };
  const mail = managerMailOf(parsed.payload);
  const mailed = [parsed.judgeMailed, parsed.earlyReviewMailed, parsed.reviewMailed].flatMap((step) => (step?.output.reviewer ? [step.output.reviewer] : []));
  const report = doneReport(parsed);
  const reviewers = reviewersAfter(parsed.take.output, mailed);
  const wait = awaiting(parsed.take.output, reviewers);
  const body = { ...mail.pullRequest, reviewers, wait, ...(report && { report }), ...(parsed.approvals && { approvals: parsed.approvals.output }) };
  const answer = await asManager(ctx, mail, "done", body, Done);
  if (answer === undefined) return { outcome: "refused" };
  for (const reviewer of abandoned(parsed.take.output, mail.runId)) await endRun(ctx, mail.tenantId, reviewer.runId);
  return answer;
}

/**
 * Stops the run once its passes end, fail or run out, so it never keeps the claim: the next manager's take finds the run
 * gone and claims the pull request.
 */
export async function stop(input: unknown, ctx: EffectContext, _signal: AbortSignal): Promise<{ stopped: true }> {
  const mail = managerMailOf(input);
  await endRun(ctx, mail.tenantId, mail.runId);
  return { stopped: true };
}
