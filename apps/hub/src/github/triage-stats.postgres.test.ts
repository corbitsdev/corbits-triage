// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { TriageStats } from "@corbits/triage-contracts";
import { migrateTriageTables } from "../triage-db.js";
import { createTriageStats } from "./triage-stats.js";
import { createVerdictRecordStore, type RecordedVerdict } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_stats";
const REPO = "acme/widgets";
const AT = new Date("2026-10-01T10:00:00Z");

function verdict(runId: string, number: number, runStatus: string | null): RecordedVerdict {
  return {
    runId, repo: REPO, number, headSha: `sha${number}`, startedAt: AT, verdictAt: AT, settled: true, state: "ready-monitoring", actor: "author",
    humanGated: false, degraded: null, checks: [], dos: [], commented: false, runStatus,
  };
}

test("PostgreSQL: only verdicts of completed runs count as triaged", async () => {
  const database = `corbits_stats_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values({ id: TENANT, name: "Stats", slug: "stats", domain: "stats.test" });
    const verdicts = createVerdictRecordStore(db);
    // #4 was recorded before runs' ends were, when only completed runs were recorded.
    // Rows under ids from before the rules were renamed: an old size row counts for the limit its evidence names, or for both without evidence.
    const oversized = { checks: [{ check: "size", kind: "machine", result: "fail", evidence: ["40 files (max 30)"] }] };
    await verdicts.record(TENANT, [
      { ...verdict("run_1", 1, "completed"), checks: [{ check: "size", result: "fail" }, { check: "ci", result: "pass" }], detail: oversized },
      verdict("run_2", 2, "failed"),
      verdict("run_3", 3, "running"),
      { ...verdict("run_4", 4, null), checks: [{ check: "size", result: "pass" }] },
    ]);

    const stats = createTriageStats({ verdicts, outcomes: async () => null, now: () => AT });
    const res = await stats(new Request(`http://hub.test/api/integrations/triage-stats/${TENANT}?repo=${REPO}`), { tenantId: TENANT, principalId: "prn_stats" });
    expect(TriageStats.assert(await res.json())).toMatchObject({
      triaged: 2,
      verdicts: { "ready-monitoring": 2 },
      checks: {
        "max-files-changed": { pass: 1, fail: 1, unconfirmed: 0 },
        "max-lines-changed": { pass: 1, fail: 0, unconfirmed: 0 },
        "ci-green": { pass: 1, fail: 0, unconfirmed: 0 },
      },
    });
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
