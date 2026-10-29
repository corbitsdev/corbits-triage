// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { diffHash } from "@corbits/common/diff-hash";
import type { PullRequestToReview } from "./pull-request-reader.js";
import { createCodeReviewRuns } from "./code-review-runs.js";
import { recordEvent, type PullRequestRef } from "./manager-state.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_reviews";
const GITHUB: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const BITBUCKET: PullRequestRef = { source: "bitbucket-datacenter", repo: "acme/widgets", number: 7 };
const RECORD = { name: "acme/widgets", connected: true };

const DIFF = "diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
// The same change on a base that changed its file outside the context lines: only the blob ids differ.
const BASE_EDITED = DIFF.replace("1111111..2222222", "3333333..4444444");
// GitHub's diff rebuilt from the file list, which has no blob ids.
const REBUILT = DIFF.replace("index 1111111..2222222 100644\n", "");

const REVIEW = {
  summary: "Adds total(), which skips the first element.",
  comments: [{ path: "src/total.ts", start: 3, end: 3, title: "total() skips the first element", body: "The loop starts at 1.", priority: 1, quoted: "for (let i = 1; i < xs.length; i++) sum += xs[i];", unverified: true as const }],
  budgetExhausted: true,
  complete: false,
  unread: [{ path: "src/a.ts", lines: [[3, 6]] as [number, number][] }],
  unreadFiles: 1,
};

const OUTPUT = { ...REVIEW, comments: REVIEW.comments.map((comment) => ({ ...comment, agreement: { finders: 1, reports: 1 } })) };

const LATER = new Date(Date.now() + 60 * 60_000).toISOString();
const EARLIER = new Date(Date.now() - 60_000).toISOString();

function reviewer(runId: string, head: string, fields: Record<string, unknown> = {}) {
  return { kind: "code-review", head, runId, deployedBy: "run_manager", deadline: LATER, ...fields };
}

function eventKey(runId: string): string {
  return `evt:github:acme/widgets#7:${runId}`;
}

test("PostgreSQL: a pull request's latest code review is what its manager recorded: one still out, what a review reported, or one it gave up on", async () => {
  const database = `corbits_reviews_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values({ id: TENANT, name: "Reviews", slug: "reviews", domain: "reviews.test", config: { corbitsTriage: { repos: [RECORD] } } });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_review", tenantId: TENANT, name: "pr-code-review-reviewer-github" });
    /** A code review the manager deployed now, after every result recorded so far. */
    async function deployed(runId: string): Promise<Date> {
      const createdAt = new Date();
      await db.insert(schema.workflowRun).values({ id: runId, definitionId: "wfd_review", anchorRunId: runId, tenantId: TENANT, status: "running", createdAt });
      return createdAt;
    }
    async function claim(reviewers: unknown[], taken: string[], status: "live" | "ended" = "live") {
      const since = new Date(0).toISOString();
      const state = { status, claimId: "claim-1", claimedAt: since, ...(status === "live" && { runId: "run_manager" }), reviewers, history: [{ id: "pass-1", head: "sha1", events: taken, takenAt: since, takes: 1, runId: "run_manager", doneAt: since }], starts: 1 };
      await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, 'mgr:github:acme/widgets#7', 'claim', ${JSON.stringify(state)}::jsonb) ON CONFLICT (tenant_id, key) DO UPDATE SET state = excluded.state`);
    }
    let head: PullRequestToReview = { title: "Fix", description: "", headSha: "sha5", draft: false, open: true, diff: DIFF };
    let hostReads = 0;
    let hostDown = false;
    const runs = createCodeReviewRuns({
      db,
      async read() {
        hostReads++;
        if (hostDown) throw new Error("github GET /repos/acme/widgets/pulls/7 -> 502");
        return head;
      },
      log() {},
    });
    async function reviewsOf(pr: PullRequestRef, asked?: string, at?: string) {
      return runs.latest(TENANT, { repo: pr.repo, source: pr.source, number: pr.number, ...(asked && { head: asked }), ...(at && { at }) });
    }

    expect(await reviewsOf(GITHUB)).toEqual({ review: null, completed: null, carriedTo: null });

    await recordEvent(db, TENANT, GITHUB, "run_old", { type: "reviewer-result", head: "sha1", payload: { kind: "code-review", result: OUTPUT } });
    await recordEvent(db, TENANT, GITHUB, "run_stray", { type: "reviewer-result", head: "sha9", payload: { kind: "code-review", result: OUTPUT } });
    await recordEvent(db, TENANT, GITHUB, "run_new", { type: "reviewer-result", head: "sha2", payload: { kind: "code-review", failed: "the review did not finish" } });
    await claim([reviewer("run_new", "sha2")], [eventKey("run_old")]);
    const finished = { status: "completed" as const, headSha: "sha1", startedAt: expect.any(String), ...REVIEW, comments: REVIEW.comments.map((comment) => ({ ...comment, thread: { state: "not-tracked" as const }, open: true })) };
    expect(await reviewsOf(GITHUB)).toEqual({ review: { status: "failed", headSha: "sha2", startedAt: expect.any(String) }, completed: finished, carriedTo: null });
    expect(await reviewsOf(BITBUCKET)).toEqual({ review: null, completed: null, carriedTo: null });

    const late = await deployed("run_late");
    await claim([reviewer("run_late", "sha3", { deadline: EARLIER, result: { failed: "overdue" } })], [eventKey("run_old"), eventKey("run_new")]);
    expect(await reviewsOf(GITHUB)).toEqual({ review: { status: "failed", headSha: "sha3", startedAt: late.toISOString() }, completed: finished, carriedTo: null });

    const live = await deployed("run_live");
    await claim([reviewer("run_live", "sha4")], [eventKey("run_old"), eventKey("run_new")]);
    expect(await reviewsOf(GITHUB)).toEqual({ review: { status: "running", headSha: "sha4", startedAt: live.toISOString() }, completed: finished, carriedTo: null });
    // A manager ends once it mailed its review, which still runs until it reports or its deadline passes, and no head takes over the finished one meanwhile.
    await claim([reviewer("run_live", "sha4")], [eventKey("run_old"), eventKey("run_new")], "ended");
    expect(await reviewsOf(GITHUB, "sha5")).toEqual({ review: { status: "running", headSha: "sha4", startedAt: live.toISOString() }, completed: finished, carriedTo: null });
    expect(hostReads).toBe(0);

    // A finished review names its diff's hash, so a later head with the same diff takes it over.
    await recordEvent(db, TENANT, GITHUB, "run_live", { type: "reviewer-result", head: "sha4", payload: { kind: "code-review", result: OUTPUT, diffHash: diffHash(DIFF) } });
    const hashed = { ...finished, headSha: "sha4", diffHash: diffHash(DIFF) };
    expect(await reviewsOf(GITHUB, "sha5")).toEqual({ review: hashed, completed: hashed, carriedTo: "sha5" });
    expect(await reviewsOf(GITHUB, "sha5")).toMatchObject({ carriedTo: "sha5" });
    expect(hostReads).toBe(1);
    expect(await reviewsOf(GITHUB, "sha4")).toMatchObject({ carriedTo: null });

    for (const [headSha, diff] of [["sha6", BASE_EDITED], ["sha7", REBUILT], ["sha8", `${DIFF}+c\n`]] as const) {
      head = { ...head, headSha, diff };
      expect(await reviewsOf(GITHUB, headSha)).toMatchObject({ carriedTo: null });
    }

    head = { ...head, headSha: "sha10", diff: DIFF };
    expect(await reviewsOf(GITHUB, "sha10")).toMatchObject({ carriedTo: "sha10" });
    expect(await reviewsOf(GITHUB, "sha11")).toMatchObject({ carriedTo: null });
    expect(hostReads).toBe(6);

    // A read that fails, or finds another head, is not tried again on every poll.
    hostDown = true;
    expect(await reviewsOf(GITHUB, "sha12")).toMatchObject({ carriedTo: null });
    expect(await reviewsOf(GITHUB, "sha12")).toMatchObject({ carriedTo: null });
    expect(await reviewsOf(GITHUB, "sha11")).toMatchObject({ carriedTo: null });
    expect(hostReads).toBe(7);

    // A review stored before every finding carried a priority still shows, without the findings that have none.
    const { priority: _priority, ...unprioritised } = OUTPUT.comments[0]!;
    await recordEvent(db, TENANT, GITHUB, "run_unprioritised", { type: "reviewer-result", head: "sha13", payload: { kind: "code-review", result: { ...OUTPUT, comments: [unprioritised, ...OUTPUT.comments] } } });
    await claim([reviewer("run_unprioritised", "sha13")], [eventKey("run_old"), eventKey("run_new"), eventKey("run_unprioritised")]);
    expect(await reviewsOf(GITHUB)).toMatchObject({ review: { status: "completed", headSha: "sha13", comments: REVIEW.comments } });

    // A finding is open until its thread is resolved or the code under it changed on a later head.
    const threaded = { ...OUTPUT, comments: [...(["resolved", "outdated", "replied", "untouched"] as const).map((state, id) => ({ ...OUTPUT.comments[0]!, thread: { id, state } })), OUTPUT.comments[0]!] };
    await recordEvent(db, TENANT, GITHUB, "run_threaded", { type: "reviewer-result", head: "sha14", payload: { kind: "code-review", result: threaded, diffHash: diffHash(DIFF) } });
    const newest = await deployed("run_newest");
    await claim([reviewer("run_newest", "sha15")], [eventKey("run_old"), eventKey("run_new"), eventKey("run_unprioritised"), eventKey("run_threaded")]);
    const shown = (await reviewsOf(GITHUB)).completed;
    expect(shown).toMatchObject({ headSha: "sha14" });
    expect(shown?.comments.map(({ thread, open }) => ({ state: thread.state, open }))).toEqual([{ state: "resolved", open: false }, { state: "outdated", open: false }, { state: "replied", open: true }, { state: "untouched", open: true }, { state: "not-tracked", open: true }]);

    // `at` answers one head's reviews, and no other head's review stands for it.
    const readsBeforeAt = hostReads;
    expect(await reviewsOf(GITHUB, undefined, "sha15")).toEqual({ review: { status: "running", headSha: "sha15", startedAt: newest.toISOString() }, completed: null, carriedTo: null });
    expect(await reviewsOf(GITHUB, undefined, "sha1")).toEqual({ review: finished, completed: finished, carriedTo: null });
    hostDown = false;
    head = { ...head, headSha: "sha16", diff: DIFF };
    expect(await reviewsOf(GITHUB, "sha16", "sha14")).toMatchObject({ review: { headSha: "sha14" }, carriedTo: null });
    expect(await reviewsOf(GITHUB, undefined, "sha16")).toEqual({ review: null, completed: null, carriedTo: null });
    expect(hostReads).toBe(readsBeforeAt);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
