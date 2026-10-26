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
import { createVerdictRecordStore } from "./verdict-record-store.js";

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

function open(number: number, now: Date): OpenPr {
  return { number, headSha: "h1", updatedAt: new Date(now.getTime() - 30 * MINUTE).toISOString(), draft: false };
}

test("PostgreSQL: the reconciler does not mail a head again while a live manager holds it, and settles a head a manager triaged or held for CI", async () => {
  await withDatabase(async function reconciled(db) {
    const now = new Date();
    const verdicts = createVerdictRecordStore(db);
    const managerRuns = createManagerRuns(db, verdicts, () => now);
    const triaged: PullRequestRef = { source: "github", repo: REPO, number: 7 };
    const held: PullRequestRef = { source: "github", repo: REPO, number: 8 };
    await managerUp(db, "run_triaged");
    await managerUp(db, "run_held");
    await mailed(db, triaged, "h1");
    await take(db, TENANT, triaged, "run_triaged");

    const queuedAt = new Date(now.getTime() - 20 * MINUTE).toISOString();
    const queued: PrTriageRow = { number: 7, headSha: "h1", status: "queued", attempts: 1, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt };
    function plan(rows: PrTriageRow[], runs: Awaited<ReturnType<typeof managerRuns>>) {
      const ci = new Map([[runKey(8, "h1"), "pending" as const]]);
      return planTenant({ repos: [{ name: REPO, prs: [open(7, now), open(8, now)], rows, ci }], runs: runs.byRepo, now, policy: DEFAULT_RECONCILE_POLICY, workflowVersion: "1.0.0" }).get(REPO)!;
    }

    const running = plan([queued], await managerRuns(TENANT, "github", "1.0.0"));
    expect(running.rows.find((row) => row.number === 7)).toMatchObject({ status: "running", runId: "run_triaged" });
    expect(running.enqueue.map((queuedPr) => queuedPr.number)).not.toContain(7);

    const result = await done(db, TENANT, triaged, "run_triaged", [], { head: "h1", request: { repo: REPO, number: 7, labels: [], owned: [], comment: "" } });
    if (result.outcome === "refused" || !result.closed) throw new Error("done refused the manager the claim names");
    await verdicts.replace(TENANT, {
      runId: "run_triaged", repo: REPO, number: 7, headSha: "h1", startedAt: new Date(result.closed.takenAt), verdictAt: now, settled: true, state: "ready-monitoring",
      actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: true, detail: { headSha: "h1", checks: [] }, runStatus: "completed",
    });
    await mailed(db, held, "h1");
    await take(db, TENANT, held, "run_held");
    await done(db, TENANT, held, "run_held", [], { head: "h1", waiting: true });
    const firstSeenAt = new Date(now.getTime() - MINUTE).toISOString();
    const fresh: PrTriageRow = { number: 8, headSha: "h1", status: "new", attempts: 0, workflowVersion: "1.0.0", firstSeenAt, updatedAt: firstSeenAt };

    const settled = plan([...running.rows.filter((row) => row.number === 7), fresh], await managerRuns(TENANT, "github", "1.0.0"));
    expect(settled.rows).toEqual([expect.objectContaining({ number: 7, status: "triaged", runId: "run_triaged" }), expect.objectContaining({ number: 8, status: "waiting", runId: "run_held" })]);
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
      const runs = await managerRuns(TENANT, "github", undefined);
      const plan = planTenant({ repos: [{ name: REPO, prs: [open(7, start)], rows }], runs: runs.byRepo, now, policy: DEFAULT_RECONCILE_POLICY, workflowVersion: undefined }).get(REPO)!;
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

    const result = await done(db, TENANT, pr, "run_manager", [], { head: "h1", request: { repo: REPO, number: 7, labels: [], owned: [], comment: "" } });
    if (result.outcome === "refused" || !result.closed) throw new Error("done refused the manager the claim names");
    await verdicts.replace(TENANT, {
      runId: "run_manager", repo: REPO, number: 7, headSha: "h1", startedAt: new Date(result.closed.takenAt), verdictAt: now, settled: true, state: "ready-monitoring",
      actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: true, detail: { headSha: "h1", checks: [] }, runStatus: "completed",
    });
    for (const afterMs of [7 * 60 * MINUTE + MINUTE, 14 * 60 * MINUTE]) {
      expect(await reconcile(afterMs)).toMatchObject({ status: "triaged", runId: "run_manager" });
    }
    expect(mails).toBe(1);
  });
}, 60_000);
