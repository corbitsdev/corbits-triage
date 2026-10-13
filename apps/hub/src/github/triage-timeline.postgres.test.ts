// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { migrateTriageTables } from "../triage-db.js";
import { createTriageTimeline, TriageTimeline } from "./triage-timeline.js";
import { createVerdictRecordStore, type RecordedVerdict } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_timeline";
const OTHER_TENANT = "tnt_timeline_other";
const REPO = "acme/widgets";
const T0 = Date.parse("2026-10-01T12:00:00Z");

function minutes(n: number): Date {
  return new Date(T0 + n * 60_000);
}

function verdict(runId: string, headSha: string, at: number, checks: RecordedVerdict["checks"], fields: Partial<RecordedVerdict> = {}): RecordedVerdict {
  return {
    runId, repo: REPO, number: 8, headSha, startedAt: minutes(at - 1), verdictAt: minutes(at), settled: true,
    state: "awaiting-review", actor: "maintainer", humanGated: false, degraded: null, checks, dos: [], commented: false, ...fields,
  };
}

test("PostgreSQL: a pull request's timeline scores each new outcome and names the checks that changed", async () => {
  const database = `corbits_timeline_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await migrateTriageTables(db, "public");
    await db.insert(schema.tenant).values([
      { id: TENANT, name: "Timeline", slug: "timeline", domain: "timeline.test" },
      { id: OTHER_TENANT, name: "Other", slug: "timeline-other", domain: "timeline-other.test" },
    ]);

    const verdicts = createVerdictRecordStore(db);
    const failing = [{ check: "ci", result: "fail" }, { check: "linked", result: "unconfirmed" }];
    await verdicts.record(TENANT, [
      verdict("run_1", "aaa", 0, failing),
      verdict("run_2", "aaa", 5, failing),
      verdict("run_3", "bbb", 10, [{ check: "ci-green", result: "fail" }], { degraded: "error", state: "stale-unknown", actor: "system" }),
      verdict("run_4", "ccc", 20, [{ check: "ci-green", result: "pass" }, { check: "linked", result: "unconfirmed" }], { settled: false }),
      verdict("run_5", "ccc", 30, [{ check: "ci-green", result: "pass" }, { check: "linked", result: "pass" }], { state: "ready-monitoring", actor: "author" }),
      verdict("run_6", "ddd", 40, [], { repo: "acme/gadgets" }),
      verdict("run_8", "fff", 60, [{ check: "size", result: "fail" }], { number: 9, detail: { checks: [{ check: "size", kind: "machine", result: "fail", evidence: ["40 files (max 30)"] }] } }),
      verdict("run_9", "ggg", 70, [{ check: "max-files-changed", result: "pass" }, { check: "max-lines-changed", result: "pass" }], { number: 9 }),
    ]);
    await verdicts.record(OTHER_TENANT, [verdict("run_7", "eee", 50, [])]);

    const timeline = createTriageTimeline({ verdicts });
    async function get(query: string): Promise<Response> {
      return timeline(new Request(`http://hub.test/api/integrations/triage-timeline/${TENANT}?${query}`), { tenantId: TENANT, principalId: "prn_timeline" });
    }

    const res = await get(`repo=${REPO}&number=8`);
    expect(res.status).toBe(200);
    const judged = { state: "awaiting-review", actor: "maintainer", settled: true, degraded: null };
    expect(TriageTimeline.assert(await res.json())).toEqual({
      repo: REPO,
      number: 8,
      entries: [
        { ...judged, at: minutes(0).toISOString(), runId: "run_1", headSha: "aaa", readiness: 25, changed: [] },
        { at: minutes(10).toISOString(), runId: "run_3", headSha: "bbb", state: "stale-unknown", actor: "system", settled: true, degraded: "error", readiness: null, changed: [] },
        { ...judged, at: minutes(20).toISOString(), runId: "run_4", headSha: "ccc", settled: false, readiness: 75, changed: [{ check: "ci-green", from: "fail", to: "pass" }] },
        {
          ...judged, at: minutes(30).toISOString(), runId: "run_5", headSha: "ccc", state: "ready-monitoring", actor: "author", readiness: 100,
          changed: [{ check: "linked", from: "unconfirmed", to: "pass" }],
        },
      ],
    });

    // An old size row compares as the limit its evidence names.
    const resized = TriageTimeline.assert(await (await get(`repo=${REPO}&number=9`)).json());
    expect(resized.entries.map((entry) => entry.changed)).toEqual([[], [{ check: "max-files-changed", from: "fail", to: "pass" }, { check: "max-lines-changed", from: null, to: "pass" }]]);

    expect((await get(`repo=${REPO}&number=0`)).status).toBe(400);
    expect((await get(`repo=${REPO}&number=2147483648`)).status).toBe(400);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
