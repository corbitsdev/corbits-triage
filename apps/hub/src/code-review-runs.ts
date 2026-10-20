// A pull request's latest code review, read from the committed run logs of its host's pr-code-review deployments; no
// table holds reviews.
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { failureReason } from "@corbits/pr-code-review/failures";
import { CodeReviewComment, REPO_SOURCES, repoSourceOf, triggerRequestOf, type RepoSource } from "@corbits/triage-contracts";
import { CODE_REVIEW_WORKFLOWS } from "./github/source-workflow.js";
import { inlineOutput } from "./github/triage-runs.js";
import type { Member } from "./integrations/app.js";

/** How many of a workspace's newest code review runs are looked through for a pull request's latest. */
const RECENT_RUNS = 200;
/** Finished runs read once and kept, as their logs never change again. */
const KEPT_RUNS = 2_000;

const Source = type.enumerated(...REPO_SOURCES);

export const CodeReviewQuery = type({ repo: "string > 0", "source?": Source, number: "string.integer.parse" });

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
});
/** A failed run's `reason` says in fixed words why it failed; the run log keeps the detail. */
const ReviewRun = CompletedRun.or({ status: "'running' | 'failed'", headSha: "string", startedAt: "string", "reason?": "string" });
export type CompletedReview = typeof CompletedRun.infer;
/** The pull request's newest review, and its newest finished one, which is the same unless a newer one is running or failed. */
export const CodeReviewFound = type({ review: ReviewRun.or("null"), completed: CompletedRun.or("null") });

type Run = { source: RepoSource; repo: string; number: number; review: typeof ReviewRun.infer };

const REQUEST = type({ kind: "'code-review'", number: "number", checkout: { source: Source, repo: "string", sha: "string" }, "cut?": Cut });

const TERMINAL_EVENTS = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

function isTerminal(event: WorkflowRunEvent): boolean {
  return TERMINAL_EVENTS.has(event.type);
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
    return { ...run, review: { ...base, status: "completed", summary: output.summary, comments, budgetExhausted: output.budgetExhausted, ...(output.cut && { cut: output.cut }) } };
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

type CodeReviewRunsDeps = { db: DB["db"]; runReader: Pick<WorkflowRunReader, "readRunEvents"> };

export function createCodeReviewRuns(deps: CodeReviewRunsDeps) {
  const finished = new Map<string, Run | undefined>();

  function keep(runId: string, run: Run | undefined): void {
    finished.set(runId, run);
    const [oldest] = finished.keys();
    if (finished.size > KEPT_RUNS && oldest !== undefined) finished.delete(oldest);
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
    if (events.some(isTerminal)) keep(row.id, run);
    return run;
  }

  async function latest(tenantId: string, query: typeof CodeReviewQuery.infer): Promise<typeof CodeReviewFound.infer> {
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId), columns: { domain: true } });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    const source = repoSourceOf(query.source);
    let review: Run["review"] | null = null;
    for (const row of await recentRuns(tenantId)) {
      if (row.anchorRunId === null) continue;
      const run = await readRun({ ...row, anchorRunId: row.anchorRunId }, tenant.domain);
      if (!run || run.source !== source || run.repo !== query.repo || run.number !== query.number) continue;
      review ??= run.review;
      if (run.review.status === "completed") return { review, completed: run.review };
    }
    return { review, completed: null };
  }

  async function latestCodeReview(query: typeof CodeReviewQuery.infer, { tenantId }: Member): Promise<Response> {
    return Response.json(await latest(tenantId, query));
  }

  return { latest, latestCodeReview };
}

export type CodeReviewRuns = ReturnType<typeof createCodeReviewRuns>;
