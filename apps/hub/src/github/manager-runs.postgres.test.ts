// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { done, recordEvent, take, type PullRequestRef } from "../manager-state.js";
import { migrateTriageTables } from "../triage-db.js";
import { createManagerRuns } from "./manager-runs.js";
import { DEFAULT_RECONCILE_POLICY, planTenant, runKey, type OpenPr } from "./reconcile-plan.js";
import { createVerdictRecordStore, replaceVerdict } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_manager_runs";
const REPO = "acme/widgets";
const MINUTE = 60_000;

type Db = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_manager_runs_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Manager runs", slug: "manager-runs", domain: "manager-runs.test" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_manager", tenantId: TENANT, name: "triage-manager-github" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

async function managerUp(db: Db, runId: string): Promise<void> {
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, status: "running" });
}

async function mailed(db: Db, pr: PullRequestRef, head: string): Promise<void> {
  await recordEvent(db, TENANT, pr, `opened-${pr.number}`, { type: "webhook", head, payload: { kind: "pr", event: "pull_request", action: "opened", headSha: head } });
}

const pr7: PullRequestRef = { source: "github", repo: REPO, number: 7 };
const pr8: PullRequestRef = { source: "github", repo: REPO, number: 8 };

/** The manager posts a settled verdict on h1 and reports done, recording it as the done route does, in done's transaction. */
async function reportedDone(db: Db, pr: PullRequestRef, runId: string, now: Date): Promise<void> {
  const report = { head: "h1", request: { repo: REPO, number: pr.number, labels: [], owned: [], comment: "" } };
  const result = await done(db, TENANT, pr, runId, [], { report, record: async function record(tx, closing) {
    if (!closing) throw new Error("a reporting pass has a closing");
    await replaceVerdict(tx, TENANT, {
      runId, repo: REPO, number: pr.number, headSha: closing.head, startedAt: new Date(closing.startedAt), verdictAt: now, settled: true, state: "ready-monitoring",
      actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: true, detail: { headSha: closing.head, checks: [] }, runStatus: "completed",
    });
  } });
  if (result.outcome === "refused") throw new Error("done refused the manager the claim names");
}

function open(number: number, now: Date): OpenPr {
  return { number, headSha: "h1", updatedAt: new Date(now.getTime() - 30 * MINUTE).toISOString(), draft: false };
}

test("PostgreSQL: the reconciler does not mail a head again while a live manager holds it, as while it waits for CI, and settles a head a manager triaged", async () => {
  await withDatabase(async function reconciled(db) {
    const now = new Date();
    const verdicts = createVerdictRecordStore(db);
    const managerRuns = createManagerRuns(db, verdicts, () => now);
    const triaged = pr7;
    const held = pr8;
    await managerUp(db, "run_triaged");
    await managerUp(db, "run_held");
    await mailed(db, triaged, "h1");
    await take(db, TENANT, triaged, "run_triaged");

    const queuedAt = new Date(now.getTime() - 20 * MINUTE).toISOString();
    const queued: PrTriageRow = { number: 7, headSha: "h1", status: "queued", attempts: 1, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt };
    function plan(rows: PrTriageRow[], runs: Awaited<ReturnType<typeof managerRuns>>) {
      return planTenant({ repos: [{ name: REPO, prs: [open(7, now), open(8, now)], rows }], runs: runs.byRepo, now, policy: DEFAULT_RECONCILE_POLICY }).get(REPO)!;
    }

    const running = plan([queued], await managerRuns(TENANT, [pr7, pr8]));
    expect(running.rows.find((row) => row.number === 7)).toMatchObject({ status: "running", runId: "run_triaged" });
    expect(running.enqueue.map((queuedPr) => queuedPr.number)).not.toContain(7);

    await reportedDone(db, triaged, "run_triaged", now);
    await mailed(db, held, "h1");
    await take(db, TENANT, held, "run_held");
    await done(db, TENANT, held, "run_held", [], { wait: true, report: { head: "h1", waiting: true } });
    const firstSeenAt = new Date(now.getTime() - MINUTE).toISOString();
    const fresh: PrTriageRow = { number: 8, headSha: "h1", status: "new", attempts: 0, firstSeenAt, updatedAt: firstSeenAt };

    const observed = await managerRuns(TENANT, [pr7, pr8]);
    expect(observed.byRepo.get(REPO)?.get(runKey(8, "h1"))).toEqual([expect.objectContaining({ runId: "run_held", status: "running", waitingSince: expect.any(String) })]);
    const settled = plan([...running.rows.filter((row) => row.number === 7), fresh], observed);
    expect(settled.rows).toEqual([expect.objectContaining({ number: 7, status: "triaged", runId: "run_triaged" }), expect.objectContaining({ number: 8, status: "running", runId: "run_held" })]);
    expect(settled.enqueue).toEqual([]);
  });
}, 60_000);

test("PostgreSQL: on the listener path a head is mailed once while its manager runs for hours, and not again once it reported done", async () => {
  await withDatabase(async function oneMail(db) {
    const start = new Date();
    let now = start;
    const verdicts = createVerdictRecordStore(db);
    const managerRuns = createManagerRuns(db, verdicts, () => now);
    const pr: PullRequestRef = { source: "github", repo: REPO, number: 7 };
    let rows: PrTriageRow[] = [];
    let mails = 0;
    async function reconcile(afterMs: number): Promise<PrTriageRow> {
      now = new Date(start.getTime() + afterMs);
      const runs = await managerRuns(TENANT, [pr]);
      const plan = planTenant({ repos: [{ name: REPO, prs: [open(7, start)], rows }], runs: runs.byRepo, now, policy: DEFAULT_RECONCILE_POLICY }).get(REPO)!;
      rows = plan.rows;
      mails += plan.enqueue.length;
      return rows[0]!;
    }

    expect(await reconcile(0)).toMatchObject({ status: "queued" });
    await managerUp(db, "run_manager");
    await mailed(db, pr, "h1");
    await take(db, TENANT, pr, "run_manager");
    for (const afterMs of [MINUTE, 11 * MINUTE, 2 * 60 * MINUTE, 7 * 60 * MINUTE]) {
      expect(await reconcile(afterMs)).toMatchObject({ status: "running", runId: "run_manager" });
    }

    await reportedDone(db, pr, "run_manager", now);
    for (const afterMs of [7 * 60 * MINUTE + MINUTE, 14 * 60 * MINUTE]) {
      expect(await reconcile(afterMs)).toMatchObject({ status: "triaged", runId: "run_manager" });
    }
    expect(mails).toBe(1);
  });
}, 60_000);

test("PostgreSQL: a manager that went away mid-pass fails its pass's head, so the head is retried with backoff", async () => {
  await withDatabase(async function gone(db) {
    const now = new Date();
    const managerRuns = createManagerRuns(db, createVerdictRecordStore(db), () => now);
    await managerUp(db, "run_gone");
    await mailed(db, pr7, "h1");
    await take(db, TENANT, pr7, "run_gone");
    await db.update(schema.workflowRun).set({ status: "failed" }).where(sql`${schema.workflowRun.id} = 'run_gone'`);

    const runs = await managerRuns(TENANT, [pr7]);
    expect(runs.byRepo.get(REPO)?.get(runKey(7, "h1"))).toEqual([expect.objectContaining({ runId: "run_gone", status: "failed" })]);
    const queuedAt = new Date(now.getTime() - MINUTE).toISOString();
    const queued: PrTriageRow = { number: 7, headSha: "h1", status: "queued", attempts: 1, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt };
    const plan = planTenant({ repos: [{ name: REPO, prs: [open(7, now)], rows: [queued] }], runs: runs.byRepo, now, policy: DEFAULT_RECONCILE_POLICY }).get(REPO)!;
    expect(plan.rows).toEqual([expect.objectContaining({ status: "failed", runId: "run_gone", error: "run failed" })]);
    expect(plan.enqueue).toEqual([]);
  });
}, 60_000);

test("PostgreSQL: a manager up between passes awaits the reviewers on its head that have not reported before their deadline", async () => {
  await withDatabase(async function awaiting(db) {
    const now = new Date();
    const managerRuns = createManagerRuns(db, createVerdictRecordStore(db), () => now);
    await managerUp(db, "run_waits");
    await mailed(db, pr7, "h1");
    await take(db, TENANT, pr7, "run_waits");
    const ahead = new Date(now.getTime() + 60 * MINUTE).toISOString();
    const reviewer = { head: "h1", deployedBy: "run_waits", deadline: ahead };
    await done(db, TENANT, pr7, "run_waits", [
      { ...reviewer, kind: "code-review", runId: "run_review" },
      { ...reviewer, kind: "judge", runId: "run_judge" },
      { ...reviewer, kind: "judge", runId: "run_judge_old", head: "h0" },
    ], { wait: true, report: { head: "h1" } });

    const runs = await managerRuns(TENANT, [pr7]);
    const [live] = runs.byRepo.get(REPO)?.get(runKey(7, "h1")) ?? [];
    expect(live).toMatchObject({ runId: "run_waits", status: "running", awaiting: ["judge", "code-review"] });
    expect(live?.passAt).toBeUndefined();

    await done(db, TENANT, pr7, "run_waits", [{ ...reviewer, kind: "judge", runId: "run_judge", result: { verdict: "pass" } }, { ...reviewer, kind: "code-review", runId: "run_review", deadline: new Date(now.getTime() - MINUTE).toISOString() }], { wait: true });
    const [after] = (await managerRuns(TENANT, [pr7])).byRepo.get(REPO)?.get(runKey(7, "h1")) ?? [];
    expect(after?.awaiting).toBeUndefined();
  });
}, 60_000);
