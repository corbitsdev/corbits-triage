// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createInMemoryGrantStore, type GrantRule } from "@intx/authz";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { TriageVerdicts } from "@corbits/triage-contracts";
import { guardedApp } from "../integrations/test-app.js";
import { migrateTriageTables } from "../triage-db.js";
import { createOpenPullsCache, type RepoPulls } from "./open-pulls.js";
import type { ObservedRun } from "./reconcile-plan.js";
import { createTenantVersions, type TenantObservation } from "./tenant-observer.js";
import { createTriageVerdicts } from "./triage-verdicts.js";
import { createVerdictRecordStore, type RecordedVerdict } from "./verdict-record-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_verdicts";
const OTHER_TENANT = "tnt_verdicts_other";
const REPO = "acme/widgets";
/** GitHub cannot list its pull requests. */
const UNREAD = "acme/unread";
const GONE = "acme/gone";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const CONFIG = { corbitsTriage: { repos: [REPO, UNREAD].map((name) => ({ name, connected: true, enabled: true })).concat({ name: GONE, connected: false, enabled: true }) } };

function minutes(n: number): Date {
  return new Date(NOW + n * 60_000);
}

const DETAIL = { priority: "P1", nextAction: "Review it", feedback: "Looks good.", evidence: ["Looks good."], checks: [{ check: "ci", kind: "machine", result: "pass" }], facts: { title: "Add widgets", mergeable: true } };

function verdict(runId: string, number: number, at: number, fields: Partial<RecordedVerdict> = {}): RecordedVerdict {
  return {
    runId, repo: REPO, number, headSha: `sha_${runId}`, startedAt: minutes(at - 1), verdictAt: minutes(at), settled: true,
    state: "awaiting-review", actor: "maintainer", humanGated: false, degraded: null, checks: [{ check: "ci", result: "pass" }], dos: [], commented: false, ...fields,
  };
}

function live(runId: string, status: ObservedRun["status"], startedAt: Date, trigger?: string): ObservedRun {
  return { runId, status, startedAt: startedAt.toISOString(), ...(trigger !== undefined && { trigger }) };
}

/** The live deployment's runs: #8's newest run failed after its verdict, #9 and #10 are still running and #6's run failed early. */
const OBSERVATION: TenantObservation = {
  deployments: [{ runId: "run_anchor", address: "pr-triage@verdicts.test", createdAt: minutes(-600), cancelling: false }],
  observed: [{
    byRepo: new Map([[REPO, new Map([
      ["8@sha_run_3", [live("run_3", "failed", minutes(9))]],
      ["9@sha9", [live("run_9", "running", minutes(-5), "pull_request:synchronize")]],
      ["10@sha10", [live("run_10", "running", minutes(-120))]],
      ["6@sha6", [live("run_6", "failed", minutes(-3))]],
    ])]]),
    runCount: 4,
    verdicts: [],
    approved: [],
  }],
};

const OPEN: RepoPulls[] = [
  { repo: REPO, prs: [6, 7, 8, 9, 10].map((number) => ({ number, title: `PR ${number}`, author: "ada", draft: false, sha: `sha${number}`, updatedAt: minutes(0).toISOString(), labels: [] })) },
  { repo: UNREAD, prs: [], error: "rate limited" },
];

test("PostgreSQL: the latest verdict of each open pull request, with the run in flight for it, answered from memory while nothing changed", async () => {
  const database = `corbits_verdicts_${randomBytes(6).toString("hex")}`;
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
      { id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config: CONFIG },
      { id: OTHER_TENANT, name: "Other", slug: "verdicts-other", domain: "verdicts-other.test", config: CONFIG },
    ]);
    await db.insert(schema.principal).values({ id: "prn_verdicts", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" });

    const store = createVerdictRecordStore(db);
    // Recorded before verdicts carried their detail or trigger.
    await store.record(TENANT, [verdict("run_1", 8, 0), verdict("run_7", 7, 1)]);
    await store.record(TENANT, [
      verdict("run_2", 8, 5, { trigger: "issue_comment:created", detail: DETAIL }),
      verdict("run_3", 8, 10, { detail: DETAIL }),
      verdict("run_5", 5, 5),
      verdict("run_4", 4, 5, { repo: GONE }),
      verdict("run_u1", 1, -30 * 24 * 60, { repo: UNREAD }),
      verdict("run_u2", 2, -60, { repo: UNREAD }),
    ]);
    await store.record(OTHER_TENANT, [verdict("run_other", 8, 30)]);

    let reads = 0;
    const verdicts = {
      ...store,
      latest(...args: Parameters<typeof store.latest>) {
        reads += 1;
        return store.latest(...args);
      },
    };
    let session: { user: { id: string } } | null = { user: { id: "usr_member" } };
    const grants: GrantRule[] = [{ id: "grt_runs", resource: "workflow-run:*", action: "read", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "prn_verdicts" }];
    let ready = false;
    let now = minutes(0);
    const versions = createTenantVersions();
    // The portal's github-open-pulls listing; the workspace has no GitHub credential, so the route never lists on its own.
    const openPulls = createOpenPullsCache(() => minutes(0));
    await openPulls.read(TENANT, async () => OPEN);
    const triageVerdicts = createTriageVerdicts({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      authorize: async () => true,
      verdicts,
      observer: { last: () => OBSERVATION },
      ready: () => ready,
      versions,
      openPulls,
      githubApiOrigin: "http://github.invalid",
      now: () => now,
    });
    const app = guardedApp(db, async () => session as never, createInMemoryGrantStore(grants), { triageVerdicts });
    async function get(query = "", headers: Record<string, string> = { "sec-fetch-site": "same-origin" }): Promise<Response> {
      return app.request(`/api/integrations/triage-verdicts/${TENANT}${query}`, { headers });
    }

    // Until the hub read the live logs since it started, any pull request may have a run going.
    const warming = TriageVerdicts.assert(await (await get()).json());
    expect(new Set(warming.pulls.map((pull) => pull.run?.status))).toEqual(new Set(["unknown"]));
    ready = true;
    // The listing is past 30 seconds old; without the GitHub credential the route keeps using it.
    now = minutes(1);
    const res = await get();
    expect(res.status).toBe(200);
    const body = TriageVerdicts.assert(await res.json());
    const byPull = new Map(body.pulls.map((pull) => [`${pull.repo}#${pull.number}`, pull]));
    // #5 is closed, #4 is in a repository no longer connected; where GitHub could not answer, only a recent verdict is listed.
    expect([...byPull.keys()]).toEqual([`${UNREAD}#2`, `${REPO}#6`, `${REPO}#7`, `${REPO}#8`, `${REPO}#9`, `${REPO}#10`]);
    expect(body.triaged).toEqual([REPO, UNREAD]);
    expect(body.active).toEqual([REPO, UNREAD]);
    expect(body.scored).toBe(false);
    expect(byPull.get(`${REPO}#8`)).toEqual({
      repo: REPO,
      number: 8,
      activityAt: minutes(4).toISOString(),
      verdict: {
        runId: "run_3", at: minutes(10).toISOString(), headSha: "sha_run_3", settled: true, state: "awaiting-review", actor: "maintainer",
        humanGated: false, degraded: null, commented: false, checks: [{ check: "ci", result: "pass" }], detail: DETAIL,
      },
      run: { runId: "run_3", startedAt: minutes(9).toISOString(), status: "failed" },
    });
    expect(byPull.get(`${REPO}#7`)?.verdict?.detail).toBeNull();
    expect(byPull.get(`${REPO}#9`)).toEqual({
      repo: REPO, number: 9, activityAt: minutes(-5).toISOString(), verdict: null, run: { runId: "run_9", startedAt: minutes(-5).toISOString(), status: "running" },
    });
    expect(byPull.get(`${REPO}#10`)?.run?.status).toBe("stuck");
    expect(byPull.get(`${REPO}#6`)?.run?.status).toBe("failed");

    // Polls while nothing changed are answered from memory; a recorded change is read once.
    const etag = res.headers.get("etag")!;
    expect((await get("", { "sec-fetch-site": "same-origin", "if-none-match": etag })).status).toBe(304);
    expect((await get()).status).toBe(200);
    expect(reads).toBe(2);
    versions.bump(TENANT);
    expect((await get("", { "sec-fetch-site": "same-origin", "if-none-match": etag })).status).toBe(304);
    expect(reads).toBe(3);

    const closed = TriageVerdicts.assert(await (await get(`?repo=${REPO}&number=5`)).json());
    expect(closed.pulls.map((pull) => [pull.number, pull.verdict?.runId])).toEqual([[5, "run_5"]]);
    expect((await get(`?repo=${GONE}&number=4`)).status).toBe(404);

    expect((await get(`?repo=${REPO}`)).status).toBe(400);
    expect((await get("", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    grants.length = 0;
    expect(await (await get()).json()).toEqual({ error: { code: "forbidden", message: "You do not have permission to perform this action" } });
    session = { user: { id: "usr_stranger" } };
    expect(await (await get()).json()).toEqual({ error: { code: "forbidden", message: "Not a member of this tenant" } });
    session = null;
    expect((await get()).status).toBe(401);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
