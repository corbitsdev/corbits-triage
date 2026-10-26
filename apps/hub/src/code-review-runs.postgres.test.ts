// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { diffHash } from "./code-review-feed.js";
import { createCodeReviewRuns } from "./code-review-runs.js";
import { recordEvent, type PullRequestRef } from "./manager-state.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_reviews";
const GITHUB: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const BITBUCKET: PullRequestRef = { source: "bitbucket-datacenter", repo: "acme/widgets", number: 7 };

const RECORD = { name: "acme/widgets", connected: true, codeReview: true };
const DIFF = "diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";

const REVIEW = {
  summary: "Adds total(), which skips the first element.",
  comments: [{ path: "src/total.ts", start: 3, end: 3, title: "total() skips the first element", body: "The loop starts at 1.", priority: 1, quoted: "for (let i = 1; i < xs.length; i++) sum += xs[i];", unverified: true as const }],
  budgetExhausted: true,
};

const OUTPUT = { ...REVIEW, comments: REVIEW.comments.map((comment) => ({ ...comment, agreement: { finders: 1, reports: 1 } })) };

test("PostgreSQL: a pull request's latest code review is the one its manager still waits on, else the newest a reviewer reported, per host", async () => {
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
    await db.insert(schema.tenant).values({ id: TENANT, name: "Reviews", slug: "reviews", domain: "reviews.test" });
    const runs = createCodeReviewRuns({
      db,
      async read() {
        throw new Error("no head is asked about");
      },
      log() {},
    });
    async function reviewsOf(pr: PullRequestRef) {
      return runs.latest(TENANT, { repo: pr.repo, source: pr.source, number: pr.number });
    }

    expect(await reviewsOf(GITHUB)).toEqual({ review: null, completed: null, carriedTo: null });

    await recordEvent(db, TENANT, GITHUB, "run_old", { type: "reviewer-result", head: "sha1", payload: { kind: "code-review", result: OUTPUT } });
    await recordEvent(db, TENANT, GITHUB, "run_judge", { type: "reviewer-result", head: "sha1", payload: { kind: "judge", failed: "the judge did not finish" } });
    const finished = { status: "completed" as const, headSha: "sha1", startedAt: expect.any(String), ...REVIEW };
    expect(await reviewsOf(GITHUB)).toEqual({ review: finished, completed: finished, carriedTo: null });
    expect(await reviewsOf(BITBUCKET)).toEqual({ review: null, completed: null, carriedTo: null });

    await recordEvent(db, TENANT, GITHUB, "run_new", { type: "reviewer-result", head: "sha2", payload: { kind: "code-review", failed: "the review did not finish" } });
    expect(await reviewsOf(GITHUB)).toEqual({ review: { status: "failed", headSha: "sha2", startedAt: expect.any(String), reason: "the review did not finish" }, completed: finished, carriedTo: null });

    await db.insert(schema.workflowDefinition).values({ id: "wfd_review", tenantId: TENANT, name: "pr-code-review-reviewer-github" });
    const deployedAt = new Date("2026-10-26T10:00:00.000Z");
    await db.insert(schema.workflowRun).values({ id: "run_live", definitionId: "wfd_review", anchorRunId: "run_live", tenantId: TENANT, status: "running", createdAt: deployedAt });
    const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
    const claim = { status: "live", claimId: "claim-1", claimedAt: deployedAt.toISOString(), runId: "run_manager", reviewers: [{ kind: "code-review", head: "sha3", runId: "run_live", deployedBy: "run_manager", deadline }], history: [], starts: 1 };
    await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, 'mgr:github:acme/widgets#7', 'claim', ${JSON.stringify(claim)}::jsonb)`);
    expect(await reviewsOf(GITHUB)).toEqual({ review: { status: "running", headSha: "sha3", startedAt: deployedAt.toISOString() }, completed: finished, carriedTo: null });

    // A finished review names its diff's hash, so a later head with the same diff takes it over.
    await recordEvent(db, TENANT, GITHUB, "run_live", { type: "reviewer-result", head: "sha3", payload: { kind: "code-review", result: OUTPUT, diffHash: diffHash(DIFF) } });
    const pull = { title: "Fix", description: "", headSha: "sha4", draft: false, open: true, diff: DIFF };
    expect(await runs.carries(TENANT, RECORD, 7, pull)).toBe(true);
    expect(await runs.carries(TENANT, RECORD, 7, { ...pull, diff: `${DIFF}+c\n` })).toBe(false);
    expect(await reviewsOf(GITHUB)).toMatchObject({ review: { status: "completed", headSha: "sha3", diffHash: diffHash(DIFF) }, completed: { headSha: "sha3" } });
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
