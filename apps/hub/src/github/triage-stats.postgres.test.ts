// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { createDoRunStore, migrateDoRuns } from "./do-run-store.js";
import { createTriageStats, TriageStats } from "./triage-stats.js";
import { createVerdictRecordStore, migrateVerdictRecords, type RecordedVerdict } from "./verdict-record-store.js";

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
  const testSchema = `corbits_stats_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateVerdictRecords(db);
    await migrateDoRuns(db);
    await db.insert(schema.tenant).values({ id: TENANT, name: "Stats", slug: "stats", domain: "stats.test" });
    await db.insert(schema.principal).values({ id: "prn_stats", tenantId: TENANT, kind: "user", refId: "usr_stats", status: "active" });
    const verdicts = createVerdictRecordStore(db);
    // #4 was recorded before runs' ends were, when only completed runs were recorded.
    await verdicts.record(TENANT, [verdict("run_1", 1, "completed"), verdict("run_2", 2, "failed"), verdict("run_3", 3, "running"), verdict("run_4", 4, null)]);

    const stats = createTriageStats({
      db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)), getSession: async () => ({ user: { id: "usr_stats" } }), authorize: async () => true,
      trustedPortalOrigins: [], verdicts, dos: createDoRunStore(db), now: () => AT,
    });
    const res = await stats(new Request(`http://hub.test/api/integrations/triage-stats/${TENANT}?repo=${REPO}`, { headers: { "sec-fetch-site": "same-origin" } }), TENANT);
    expect(TriageStats.assert(await res.json())).toMatchObject({ triaged: 2, verdicts: { "ready-monitoring": 2 } });
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
