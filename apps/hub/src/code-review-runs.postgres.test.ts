// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { diffHash, type PullRequestToReview } from "./code-review-feed.js";
import { createCodeReviewRuns } from "./code-review-runs.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_reviews";
const RECORD = { name: "acme/widgets", connected: true, codeReview: true };

const DIFF = "diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
// The same change on a base that changed its file outside the context lines: only the blob ids differ.
const BASE_EDITED = DIFF.replace("1111111..2222222", "3333333..4444444");
// GitHub's diff rebuilt from the file list, which has no blob ids.
const REBUILT = DIFF.replace("index 1111111..2222222 100644\n", "");

function request(number: number, sha: string, hashed?: string) {
  return { kind: "code-review", number, title: "Fix", description: "", diff: "diff --git a/x b/x\n", checkout: { source: "github", repo: "acme/widgets", sha }, ...(hashed !== undefined && { diffHash: diffHash(hashed) }) };
}

function started(number: number, sha: string, hashed?: string): WorkflowRunEvent {
  return { seq: 0, type: "RunStarted", ts: "2026-10-17T00:00:00.000Z", body: { trigger: { payload: request(number, sha, hashed) } } } as unknown as WorkflowRunEvent;
}

const REVIEW = {
  summary: "Adds total(), which skips the first element.",
  comments: [{ path: "src/total.ts", start: 3, end: 3, title: "total() skips the first element", body: "The loop starts at 1.", priority: 1, quoted: "for (let i = 1; i < xs.length; i++) sum += xs[i];", unverified: true as const }],
  budgetExhausted: true,
};

const OUTPUT = { ...REVIEW, comments: REVIEW.comments.map((comment) => ({ ...comment, agreement: { finders: 1, reports: 1 } })) };

const LOGS: Record<string, WorkflowRunEvent[]> = {
  run_old: [
    started(7, "sha1"),
    { seq: 1, type: "StepCompleted", body: { stepId: "review", output: { ref: `inline:${JSON.stringify(OUTPUT)}` } } } as unknown as WorkflowRunEvent,
    { seq: 2, type: "RunCompleted", body: {} } as unknown as WorkflowRunEvent,
  ],
  run_other: [started(8, "sha9")],
  run_new: [
    started(7, "sha2"),
    { seq: 1, type: "StepFailed", body: { stepId: "findDiff", attempt: 1, error: { message: "reactor error: Director exception: reader: inference failed: 529 overloaded" }, retriesExhausted: false } } as unknown as WorkflowRunEvent,
    { seq: 2, type: "StepFailed", body: { stepId: "findDiff", attempt: 3, error: { message: "reactor error: Director exception: reader: no findings list in the answer" }, retriesExhausted: true } } as unknown as WorkflowRunEvent,
    { seq: 3, type: "StepFailed", body: { stepId: "candidates", attempt: 1, error: { message: "missing field findDiff in project selector source" }, retriesExhausted: true } } as unknown as WorkflowRunEvent,
  ],
  run_hashed: [
    started(7, "sha3", DIFF),
    { seq: 1, type: "StepCompleted", body: { stepId: "review", output: { ref: `inline:${JSON.stringify(OUTPUT)}` } } } as unknown as WorkflowRunEvent,
    { seq: 2, type: "RunCompleted", body: {} } as unknown as WorkflowRunEvent,
  ],
};

test("PostgreSQL: a pull request's latest code review comes from the newest run that names it, and stands for a head with its diff", async () => {
  const database = `corbits_reviews_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Reviews", slug: "reviews", domain: "reviews.test", config: { corbitsTriage: { repos: [RECORD] } } });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_review", tenantId: TENANT, name: "pr-code-review-github", status: "stopped" });
    await db.insert(schema.workflowRun).values({ id: "wfr_anchor", definitionId: "wfd_review", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "deployed" });
    const at = (minute: number) => new Date(`2026-10-17T00:0${minute}:00.000Z`);
    await db.insert(schema.workflowRun).values([
      { id: "run_old", definitionId: "wfd_review", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "completed", createdAt: at(1) },
      { id: "run_other", definitionId: "wfd_review", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "running", createdAt: at(2) },
    ]);
    const reads: string[] = [];
    // A rebase onto base changes to other files: the diff, blob ids included, is as it was.
    let head: PullRequestToReview = { title: "Fix", description: "", headSha: "sha4", draft: false, open: true, diff: DIFF };
    let hostReads = 0;
    let hostDown = false;
    const runs = createCodeReviewRuns({
      db,
      runReader: {
        async readRunEvents(_repoId, _ref, runId) {
          reads.push(runId);
          return LOGS[runId] ?? [];
        },
      },
      async read() {
        hostReads++;
        if (hostDown) throw new Error("github GET /repos/acme/widgets/pulls/7 -> 502");
        return head;
      },
      log() {},
    });
    async function reviewsOf(number: number) {
      return runs.latest(TENANT, { repo: "acme/widgets", number });
    }
    const finished = { status: "completed" as const, headSha: "sha1", startedAt: at(1).toISOString(), summary: REVIEW.summary, comments: REVIEW.comments, budgetExhausted: true };

    expect(await reviewsOf(7)).toEqual({ review: finished, completed: finished, carriedTo: null });
    expect(await reviewsOf(8)).toEqual({ review: { status: "running", headSha: "sha9", startedAt: at(2).toISOString() }, completed: null, carriedTo: null });
    expect(await reviewsOf(9)).toEqual({ review: null, completed: null, carriedTo: null });

    await db.insert(schema.workflowRun).values({ id: "run_new", definitionId: "wfd_review", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "failed", createdAt: at(3) });
    expect(await reviewsOf(7)).toEqual({ review: { status: "failed", headSha: "sha2", startedAt: at(3).toISOString(), reason: "The diff reviewer's answer couldn't be read." }, completed: finished, carriedTo: null });
    expect(reads.filter((runId) => runId === "run_old")).toHaveLength(1);

    await db.insert(schema.workflowRun).values({ id: "run_hashed", definitionId: "wfd_review", anchorRunId: "wfr_anchor", tenantId: TENANT, status: "completed", createdAt: at(4) });
    const hashed = { ...finished, headSha: "sha3", startedAt: at(4).toISOString(), diffHash: diffHash(DIFF) };
    expect(await runs.carries(TENANT, RECORD, 7, head)).toBe(true);
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha4" })).toEqual({ review: hashed, completed: hashed, carriedTo: "sha4" });
    expect(hostReads).toBe(0);
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha3" })).toMatchObject({ carriedTo: null });

    expect(await runs.carries(TENANT, RECORD, 7, { ...head, headSha: "sha5", diff: BASE_EDITED })).toBe(false);
    expect(await runs.carries(TENANT, RECORD, 7, { ...head, headSha: "sha6", diff: REBUILT })).toBe(false);
    expect(await runs.carries(TENANT, RECORD, 7, { ...head, headSha: "sha7", diff: `${DIFF}+c\n` })).toBe(false);

    head = { ...head, headSha: "sha8" };
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha8" })).toMatchObject({ carriedTo: "sha8" });
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha9" })).toMatchObject({ carriedTo: null });
    expect(hostReads).toBe(2);

    // A read that fails, or finds another head, is not tried again on every poll.
    hostDown = true;
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha10" })).toMatchObject({ carriedTo: null });
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha10" })).toMatchObject({ carriedTo: null });
    expect(await runs.latest(TENANT, { repo: "acme/widgets", number: 7, head: "sha9" })).toMatchObject({ carriedTo: null });
    expect(hostReads).toBe(3);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
