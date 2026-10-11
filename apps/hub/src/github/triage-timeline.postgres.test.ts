// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { createTriageTimeline, TriageTimeline } from "./triage-timeline.js";
import { createVerdictRecordStore, migrateVerdictRecords, type RecordedVerdict } from "./verdict-record-store.js";

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

async function signedInSession() {
  return { user: { id: "usr_timeline" }, session: { id: "ses_timeline" } };
}

async function allow(): Promise<boolean> {
  return true;
}

test("PostgreSQL: a pull request's timeline scores each new outcome and names the checks that changed", async () => {
  const testSchema = `corbits_timeline_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateVerdictRecords(db);
    await db.insert(schema.tenant).values([
      { id: TENANT, name: "Timeline", slug: "timeline", domain: "timeline.test" },
      { id: OTHER_TENANT, name: "Other", slug: "timeline-other", domain: "timeline-other.test" },
    ]);
    await db.insert(schema.principal).values({ id: "prn_timeline", tenantId: TENANT, kind: "user", refId: "usr_timeline", status: "active" });

    const verdicts = createVerdictRecordStore(db);
    const failing = [{ check: "ci", result: "fail" }, { check: "linked", result: "unconfirmed" }];
    await verdicts.record(TENANT, [
      verdict("run_1", "aaa", 0, failing),
      verdict("run_2", "aaa", 5, failing),
      verdict("run_3", "bbb", 10, [{ check: "ci", result: "fail" }], { degraded: "error", state: "stale-unknown", actor: "system" }),
      verdict("run_4", "ccc", 20, [{ check: "ci", result: "pass" }, { check: "linked", result: "unconfirmed" }], { settled: false }),
      verdict("run_5", "ccc", 30, [{ check: "ci", result: "pass" }, { check: "linked", result: "pass" }], { state: "ready-monitoring", actor: "author" }),
      verdict("run_6", "ddd", 40, [], { repo: "acme/gadgets" }),
    ]);
    await verdicts.record(OTHER_TENANT, [verdict("run_7", "eee", 50, [])]);

    const timeline = createTriageTimeline({
      db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)), getSession: signedInSession, authorize: allow, trustedPortalOrigins: [], verdicts,
    });
    async function get(query: string): Promise<Response> {
      return timeline(new Request(`http://hub.test/api/integrations/triage-timeline/${TENANT}?${query}`, { headers: { "sec-fetch-site": "same-origin" } }), TENANT);
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
        { ...judged, at: minutes(20).toISOString(), runId: "run_4", headSha: "ccc", settled: false, readiness: 75, changed: [{ check: "ci", from: "fail", to: "pass" }] },
        {
          ...judged, at: minutes(30).toISOString(), runId: "run_5", headSha: "ccc", state: "ready-monitoring", actor: "author", readiness: 100,
          changed: [{ check: "linked", from: "unconfirmed", to: "pass" }],
        },
      ],
    });

    expect((await get(`repo=${REPO}&number=0`)).status).toBe(400);
    expect((await get(`repo=${REPO}&number=2147483648`)).status).toBe(400);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
