// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import type { RepoId, WorkflowRunEvent, WorkflowRunReader } from "@intx/hub-sessions";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { createTenantVersions } from "./tenant-observer.js";
import { createVerdictBackfill, migrateVerdictBackfill } from "./verdict-backfill.js";
import { createVerdictRecordStore, migrateVerdictRecords, verdictRecord } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_backfill";
const REPO = "acme/widgets";
const AT = "2026-09-01T12:00:00.000Z";

/** A completed run of #`number`, started by a push, with the facts its rules step read. */
function run(number: number): WorkflowRunEvent[] {
  const mail = stockTriggerMail({ kind: "pr", repo: REPO, prNumber: number, headSha: `sha${number}`, event: "pull_request", action: "synchronize" });
  const facts = { repo: REPO, number, title: `PR ${number}`, author: "ann" };
  const verdict = { repo: REPO, number, headSha: `sha${number}`, state: "awaiting-review", actor: "maintainer", humanGated: false, degraded: null, reason: "", checks: [] };
  return [
    { seq: 0, type: "RunStarted", body: { at: AT, trigger: { type: "mail", payload: mail } } },
    { seq: 1, type: "StepCompleted", body: { at: AT, stepId: "rules", output: { ref: `inline:${JSON.stringify({ items: [{ facts, det: { findings: [{ reason: "Waiting on review." }] } }] })}` } } },
    { seq: 2, type: "StepCompleted", body: { at: AT, stepId: "evaluate", output: { ref: `inline:${JSON.stringify(verdict)}` } } },
    { seq: 3, type: "RunCompleted", body: { at: AT } },
  ];
}

test("PostgreSQL: verdicts are filled in and recorded from ended deployments' logs, each read once; live ones and missing logs are left", async () => {
  const testSchema = `corbits_backfill_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateVerdictRecords(db);
    await migrateVerdictBackfill(db);
    await db.insert(schema.tenant).values({ id: TENANT, name: "Backfill", slug: "backfill", domain: "backfill.test" });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_backfill", tenantId: TENANT, name: "pr-triage", status: "stopped" });
    await db.insert(schema.workflowRun).values([
      { id: "run_released", definitionId: "wfd_backfill", anchorRunId: "run_released", tenantId: TENANT, status: "completed" },
      { id: "run_live", definitionId: "wfd_backfill", anchorRunId: "run_live", tenantId: TENANT, status: "deployed" },
      { id: "run_gone", definitionId: "wfd_backfill", anchorRunId: "run_gone", tenantId: TENANT, status: "failed" },
    ]);
    const logs: Record<string, WorkflowRunEvent[]> = { run_7: run(7), run_8: run(8) };
    const reads: string[] = [];
    const runReader = {
      async hasRepository(repoId: RepoId) {
        return !repoId.id.includes("run_gone");
      },
      async listRunIds(repoId: RepoId) {
        return repoId.id.includes("run_released") ? ["run_released", "run_7", "run_8"] : [];
      },
      async readRunEvents(_repoId: RepoId, _ref: string, runId: string) {
        reads.push(runId);
        return logs[runId] ?? [];
      },
    } as unknown as WorkflowRunReader;

    const store = createVerdictRecordStore(db);
    // #7 was recorded before verdicts kept what the portal shows; #8 never was.
    await store.record(TENANT, [{
      runId: "run_7", repo: REPO, number: 7, headSha: "sha7", startedAt: new Date(AT), verdictAt: new Date(AT), settled: true,
      state: "awaiting-review", actor: "maintainer", humanGated: false, degraded: null, checks: [], dos: [], commented: true,
    }]);
    const logged: Array<Record<string, unknown>> = [];
    const backfill = createVerdictBackfill({
      db, runReader, verdicts: store, versions: createTenantVersions(), workflow: "pr-triage", now: () => new Date(AT), log: (entry) => logged.push(entry),
    });
    await backfill();
    await backfill();

    const rows = await db.select().from(verdictRecord).where(and(eq(verdictRecord.tenantId, TENANT), eq(verdictRecord.repo, REPO)));
    expect(rows.map(({ number, trigger, commented, detail }) => ({ number, trigger, commented, detail })).sort((a, b) => a.number - b.number)).toEqual([7, 8].map((number) => ({
      number,
      trigger: "pull_request:synchronize",
      commented: number === 7,
      detail: { headSha: `sha${number}`, reason: "", evidence: ["Waiting on review."], checks: [], facts: { title: `PR ${number}`, author: "ann" } },
    })));
    expect(reads).toEqual(["run_7", "run_8"]);
    expect(logged.map((entry) => [entry["msg"], entry["deployment"]])).toEqual([
      ["triage_verdicts_backfilled", "run_released"],
      ["triage_verdicts_backfill_skipped", "run_gone"],
      ["triage_verdicts_backfill_skipped", "run_gone"],
    ]);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
