// A pull request's latest code review, read from the committed run logs of its host's pr-code-review deployments; no
// table holds reviews. A head whose diff is the one the latest review read, as after a rebase that changed no line of
// it, takes that review over instead of being reviewed again.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { classifyTerminalEvent, WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { failureReason } from "@corbits/pr-code-review/failures";
import { CodeReviewComment, REPO_SOURCES, repoSourceOf, triggerRequestOf, type RepoSource } from "@corbits/triage-contracts";
import { diffHash, type PullRequestToReview } from "./code-review-feed.js";
import { CODE_REVIEW_WORKFLOWS } from "./github/source-workflow.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./github/tenant-config.js";
import { inlineOutput } from "./github/triage-runs.js";
import type { Member } from "./integrations/app.js";

/** How many of a workspace's newest code review runs are looked through for a pull request's latest. */
const RECENT_RUNS = 200;
/** Finished runs read once and kept, as their logs never change again. */
const KEPT_RUNS = 2_000;
/** Heads compared with the review before them; only a comparison made is kept, never a read that failed. */
const KEPT_CARRIES = 2_000;
/** A head whose diff could not be read is not read again for the portal sooner than this. */
const UNREAD_RETRY_MS = 5 * 60_000;

const Source = type.enumerated(...REPO_SOURCES);

/** `head` is the pull request's head as the asker last read it, which the newest finished review may stand for. */
export const CodeReviewQuery = type({ repo: "string > 0", "source?": Source, number: "string.integer.parse", "head?": "string > 0" });

const Cut = type({ lines: "number", of: "number", "unread?": "string[]" });
const Review = type({ summary: "string", comments: CodeReviewComment.array(), budgetExhausted: "boolean", "cut?": Cut });
const CompletedRun = type({
  status: "'completed'",
  headSha: "string",
  startedAt: "string",
  summary: "string",
  comments: CodeReviewComment.array(),
  budgetExhausted: "boolean",
  "cut?": Cut,
  "diffHash?": "string",
});
/** A failed run's `reason` says in fixed words why it failed; the run log keeps the detail. */
const ReviewRun = CompletedRun.or({ status: "'running' | 'failed'", headSha: "string", startedAt: "string", "reason?": "string" });
export type CompletedReview = typeof CompletedRun.infer;
/**
 * The pull request's newest review, and its newest finished one, which is the same unless a newer one is running or
 * failed; `carriedTo` is the asked head when the finished review stands for it too.
 */
export const CodeReviewFound = type({ review: ReviewRun.or("null"), completed: CompletedRun.or("null"), carriedTo: "string | null" });
type Found = Omit<typeof CodeReviewFound.infer, "carriedTo">;

type Run = { source: RepoSource; repo: string; number: number; review: typeof ReviewRun.infer };

const REQUEST = type({ kind: "'code-review'", number: "number", checkout: { source: Source, repo: "string", sha: "string" }, "cut?": Cut, "diffHash?": "string" });

function isTerminal(event: WorkflowRunEvent): boolean {
  return classifyTerminalEvent(event.type).terminal;
}

/** The run's request and outcome; undefined for a run that names no pull request, such as one an eval started. */
function runOf(events: readonly WorkflowRunEvent[], status: string, createdAt: Date): Run | undefined {
  const started = events.find((event) => event.type === "RunStarted");
  const request = REQUEST(triggerRequestOf((started?.body["trigger"] as { payload?: unknown } | undefined)?.payload));
  if (request instanceof type.errors) return undefined;
  const run = { source: request.checkout.source, repo: request.checkout.repo, number: request.number };
  const base = { headSha: request.checkout.sha, startedAt: createdAt.toISOString() };
  const output = Review(inlineOutput(events.findLast((event) => event.type === "StepCompleted" && event.body["stepId"] === "review")));
  if (!(output instanceof type.errors)) {
    const comments = output.comments.map(({ path, start, end, title, body, priority, quoted, unverified }) => ({ path, start, end, title, body, ...(priority !== undefined && { priority }), ...(quoted !== undefined && { quoted }), ...(unverified && { unverified }) }));
    return { ...run, review: { ...base, status: "completed", summary: output.summary, comments, budgetExhausted: output.budgetExhausted, ...(output.cut && { cut: output.cut }), ...(request.diffHash && { diffHash: request.diffHash }) } };
  }
  const ended = !schema.isLiveWorkflowRunStatus(status) || events.some(isTerminal);
  if (!ended) return { ...run, review: { ...base, status: "running" } };
  const reason = reasonOf(events);
  return { ...run, review: { ...base, status: "failed", ...(reason && { reason }) } };
}

const StepFailed = type({ stepId: "string", error: { message: "string" }, retriesExhausted: "true" });

/** Why the first step that failed for good did; the steps after it fail only for want of its output. */
function reasonOf(events: readonly WorkflowRunEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== "StepFailed") continue;
    const failed = StepFailed(event.body);
    if (!(failed instanceof type.errors)) return failureReason(failed.stepId, failed.error.message);
  }
  return undefined;
}

type CodeReviewRunsDeps = {
  db: DB["db"];
  runReader: Pick<WorkflowRunReader, "readRunEvents">;
  read: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  log: (entry: Record<string, unknown>) => void;
};

function keep<V>(kept: Map<string, V>, key: string, value: V, max: number): void {
  kept.set(key, value);
  const [oldest] = kept.keys();
  if (kept.size > max && oldest !== undefined) kept.delete(oldest);
}

/** The review a head other than its own could take over: the newest, finished, and with its diff's hash. */
function carriable({ review, completed }: Found, headSha: string): CompletedReview | undefined {
  if (completed === null || review !== completed || completed.headSha === headSha || completed.diffHash === undefined) return undefined;
  return completed;
}

export function createCodeReviewRuns(deps: CodeReviewRunsDeps) {
  const finished = new Map<string, Run | undefined>();
  const compared = new Map<string, boolean>();
  const unread = new Map<string, number>();

  function comparedKey(tenantId: string, source: RepoSource, repo: string, number: number, from: string, to: string): string {
    return `${tenantId}\n${source}\n${repo}\n${number}\n${from}\n${to}`;
  }

  async function recentRuns(tenantId: string) {
    const { workflowRun, workflowDefinition } = schema;
    return deps.db
      .select({ id: workflowRun.id, anchorRunId: workflowRun.anchorRunId, status: workflowRun.status, createdAt: workflowRun.createdAt })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .where(and(eq(workflowRun.tenantId, tenantId), inArray(workflowDefinition.name, CODE_REVIEW_WORKFLOWS.map((workflow) => workflow.id)), ne(workflowRun.id, workflowRun.anchorRunId)))
      .orderBy(desc(workflowRun.createdAt), desc(workflowRun.id))
      .limit(RECENT_RUNS);
  }

  async function readRun(row: { id: string; anchorRunId: string; status: string; createdAt: Date }, domain: string): Promise<Run | undefined> {
    if (finished.has(row.id)) return finished.get(row.id);
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(row.anchorRunId, domain));
    const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, row.id);
    const run = runOf(events, row.status, row.createdAt);
    // Only a log that has ended is kept: one whose status is ahead of its log is read again.
    if (events.some(isTerminal)) keep(finished, row.id, run, KEPT_RUNS);
    return run;
  }

  async function tenantOf(tenantId: string) {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true, config: true } });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    return tenant;
  }

  async function reviewsOf(tenantId: string, domain: string, source: RepoSource, repo: string, number: number): Promise<Found> {
    let review: Run["review"] | null = null;
    for (const row of await recentRuns(tenantId)) {
      if (row.anchorRunId === null) continue;
      const run = await readRun({ ...row, anchorRunId: row.anchorRunId }, domain);
      if (!run || run.source !== source || run.repo !== repo || run.number !== number) continue;
      review ??= run.review;
      if (run.review.status === "completed") return { review, completed: run.review };
    }
    return { review, completed: null };
  }

  function sameDiff(tenantId: string, record: RepoRecord, number: number, completed: CompletedReview, head: Pick<PullRequestToReview, "headSha" | "diff">): boolean {
    const hash = diffHash(head.diff);
    const same = hash !== undefined && completed.diffHash === hash;
    keep(compared, comparedKey(tenantId, sourceOf(record), record.name, number, completed.headSha, head.headSha), same, KEPT_CARRIES);
    return same;
  }

  /** The pull request read for the portal, unless reading it failed or found another head within `UNREAD_RETRY_MS`. */
  async function readFor(tenantId: string, record: RepoRecord, number: number, head: string, key: string): Promise<PullRequestToReview | undefined> {
    const failedAt = unread.get(key);
    if (failedAt !== undefined && Date.now() - failedAt < UNREAD_RETRY_MS) return undefined;
    try {
      const pull = await deps.read(tenantId, record, number);
      if (pull.headSha === head) return pull;
    } catch (err) {
      deps.log({ level: "warn", msg: "code_review_carry_unread", tenantId, repo: record.name, pr: number, error: String(err) });
    }
    keep(unread, key, Date.now(), KEPT_CARRIES);
    return undefined;
  }

  /** `head`, when the pull request is at it and its diff is the one the newest finished review read. */
  async function carriedTo(tenantId: string, config: unknown, query: typeof CodeReviewQuery.infer, reviews: Found): Promise<string | null> {
    const { head, repo, number } = query;
    const source = repoSourceOf(query.source);
    const completed = head === undefined ? undefined : carriable(reviews, head);
    if (head === undefined || !completed) return null;
    const key = comparedKey(tenantId, source, repo, number, completed.headSha, head);
    const known = compared.get(key);
    if (known !== undefined) return known ? head : null;
    const record = repoRecords(triageNs(config)).find((row) => row.name === repo && sourceOf(row) === source && row.connected);
    const pull = record && (await readFor(tenantId, record, number, head, key));
    return record && pull && sameDiff(tenantId, record, number, completed, pull) ? head : null;
  }

  async function latest(tenantId: string, query: typeof CodeReviewQuery.infer): Promise<typeof CodeReviewFound.infer> {
    const tenant = await tenantOf(tenantId);
    const reviews = await reviewsOf(tenantId, tenant.domain, repoSourceOf(query.source), query.repo, query.number);
    return { ...reviews, carriedTo: await carriedTo(tenantId, tenant.config, query, reviews) };
  }

  /** Whether `pull`'s head takes the newest review over rather than being reviewed; false when that can't be told. */
  async function carries(tenantId: string, record: RepoRecord, number: number, pull: PullRequestToReview): Promise<boolean> {
    try {
      const { domain } = await tenantOf(tenantId);
      const completed = carriable(await reviewsOf(tenantId, domain, sourceOf(record), record.name, number), pull.headSha);
      return completed !== undefined && sameDiff(tenantId, record, number, completed, pull);
    } catch (err) {
      deps.log({ level: "warn", msg: "code_review_carry_unread", tenantId, repo: record.name, pr: number, error: String(err) });
      return false;
    }
  }

  async function latestCodeReview(query: typeof CodeReviewQuery.infer, { tenantId }: Member): Promise<Response> {
    return Response.json(await latest(tenantId, query));
  }

  return { latest, carries, latestCodeReview };
}

export type CodeReviewRuns = ReturnType<typeof createCodeReviewRuns>;
