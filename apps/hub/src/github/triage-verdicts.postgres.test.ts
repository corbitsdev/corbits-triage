// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createInMemoryGrantStore, type GrantRule } from "@intx/authz";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { TRIAGE_MANAGERS, TriageVerdicts, type PrTriageRow } from "@corbits/triage-contracts";
import { guardedApp } from "../integrations/test-app.js";
import { migrateTriageTables } from "../triage-db.js";
import { TOKEN_CREDENTIAL } from "../bitbucket-datacenter/records.js";
import { createGithubOpenPulls, createOpenPullsCache, GITHUB_OPEN_PULLS_PATH, type RepoPulls } from "./open-pulls.js";
import type { RepoRecord } from "./tenant-config.js";
import type { ObservedRun } from "./reconcile-plan.js";
import type { ObservedRuns } from "./manager-runs.js";
import { createTriageVerdicts } from "./triage-verdicts.js";
import { createVerdictRecordStore, type RecordedVerdict, replaceVerdict } from "./verdict-record-store.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

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

const DETAIL = { priority: "P1", nextAction: "Review it", feedback: "Looks good.", evidence: ["Looks good."], checks: [{ check: "ci-green", kind: "machine", result: "pass" }], facts: { title: "Add widgets", mergeable: true } };

function verdict(runId: string, number: number, at: number, fields: Partial<RecordedVerdict> = {}): RecordedVerdict {
  return {
    runId, repo: REPO, number, headSha: `sha_${runId}`, startedAt: minutes(at - 1), verdictAt: minutes(at), settled: true,
    state: "awaiting-review", actor: "maintainer", humanGated: false, degraded: null, checks: [{ check: "ci-green", result: "pass" }], dos: [], commented: false, ...fields,
  };
}

/** Seeds verdict rows as managers record them. */
async function seed(db: DB, tenantId: string, verdicts: readonly RecordedVerdict[]): Promise<void> {
  for (const verdict of verdicts) await replaceVerdict(db, tenantId, verdict);
}

/** A running manager has a pass open, taken when it started. */
function live(runId: string, status: ObservedRun["status"], startedAt: Date, trigger?: string): ObservedRun {
  return { runId, source: "github", status, startedAt: startedAt.toISOString(), ...(status === "running" && { passAt: startedAt.toISOString() }), ...(trigger !== undefined && { trigger }) };
}

function observed(byHead: Array<[string, ObservedRun[]]>): ObservedRuns {
  return { byRepo: new Map([[REPO, new Map(byHead)]]) };
}

const NO_RUNS: ObservedRuns = { byRepo: new Map() };

/**
 * The managers' runs: #8's newest run failed after its verdict, #9 and #10 are still running and #6's run failed early; #7 has no run, but waits for CI.
 * #4 of the repository GitHub could not list has a failed run.
 */
const MANAGED: ObservedRuns = {
  byRepo: new Map([
    ...observed([
      ["8@sha_run_3", [live("run_3", "failed", minutes(9))]],
      ["9@sha9", [live("run_9", "running", minutes(-5), "pull_request:synchronize")]],
      ["10@sha10", [live("run_10", "running", minutes(-120))]],
      ["6@sha6", [live("run_6", "failed", minutes(-3))]],
    ]).byRepo,
    [UNREAD, new Map([["4@sha_u4", [live("run_u4", "failed", minutes(-2))]]])],
  ]),
};

/** #14 is open with no head GitHub could name. */
const OPEN: RepoPulls[] = [
  { repo: REPO, source: "github", prs: [6, 7, 8, 9, 10, 11, 12, 14].map((number) => ({ number, title: `PR ${number}`, author: "ada", draft: false, sha: number === 14 ? "" : `sha${number}`, branch: null, updatedAt: minutes(0).toISOString(), labels: [], url: null })) },
  { repo: UNREAD, source: "github", prs: [], error: "rate limited" },
];

/**
 * #7 waits for CI; #8's degraded run kept its verdict, #11's run never started, #12's mail failed to send and #6's run failed on a head since pushed over.
 * The runs of #13, since closed, and #14, open while its host gives no head, failed.
 */
const waitingRows: PrTriageRow[] = [
  { number: 7, headSha: "sha_waiting", status: "waiting", attempts: 0, firstSeenAt: minutes(-3).toISOString(), updatedAt: minutes(-3).toISOString() },
  { number: 8, headSha: "sha_run_3", status: "failed", attempts: 1, error: "degraded: the policy could not be read", firstSeenAt: minutes(9).toISOString(), updatedAt: minutes(10).toISOString() },
  { number: 11, headSha: "sha11", status: "failed", attempts: 3, error: "run never started", firstSeenAt: minutes(-4).toISOString(), updatedAt: minutes(-4).toISOString() },
  { number: 12, headSha: "sha12", status: "failed", attempts: 1, error: "delivery failed: connection refused", firstSeenAt: minutes(-4).toISOString(), updatedAt: minutes(-4).toISOString() },
  { number: 6, headSha: "sha6_old", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-6).toISOString(), updatedAt: minutes(-6).toISOString() },
  { number: 13, headSha: "sha13", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-6).toISOString(), updatedAt: minutes(-6).toISOString() },
  { number: 14, headSha: "sha14", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-6).toISOString(), updatedAt: minutes(-6).toISOString() },
];

/** In the repository GitHub could not list, #3 has since closed and #4 is open with its manager's run; the run of each failed. */
const unreadRows: PrTriageRow[] = [
  { number: 3, headSha: "sha_u3", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-6).toISOString(), updatedAt: minutes(-6).toISOString() },
  { number: 4, headSha: "sha_u4", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-2).toISOString(), updatedAt: minutes(-2).toISOString() },
];

type DB = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: DB) => Promise<void>): Promise<void> {
  const database = `corbits_verdicts_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: the latest verdict of each open pull request, with the run in flight for it, answered from memory while nothing changed", async () => {
  await withDatabase(async function verdictsOfOpenPulls(db) {
    await db.insert(schema.tenant).values([
      { id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config: CONFIG },
      { id: OTHER_TENANT, name: "Other", slug: "verdicts-other", domain: "verdicts-other.test", config: CONFIG },
    ]);
    await db.insert(schema.principal).values({ id: "prn_verdicts", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" });

    const store = createVerdictRecordStore(db);
    // Recorded before verdicts carried their detail or trigger.
    await seed(db, TENANT, [verdict("run_1", 8, 0), verdict("run_7", 7, 1)]);
    await seed(db, TENANT, [
      verdict("run_2", 8, 5, { trigger: "issue_comment:created", detail: DETAIL }),
      verdict("run_3", 8, 10, { detail: DETAIL }),
      verdict("run_5", 5, 5),
      verdict("run_4", 4, 5, { repo: GONE }),
      verdict("run_u1", 1, -30 * 24 * 60, { repo: UNREAD }),
      verdict("run_u2", 2, -60, { repo: UNREAD }),
    ]);
    await seed(db, OTHER_TENANT, [verdict("run_other", 8, 30)]);

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
    let now = minutes(0);
    let managed = MANAGED;
    // The portal's github-open-pulls listing; the workspace has no GitHub credential, so the route never lists on its own.
    const openPulls = createOpenPullsCache(() => minutes(0));
    await openPulls.read(TENANT, async () => OPEN);
    const triageVerdicts = createTriageVerdicts({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      onKeyMoved: noKeyPush,
      authorize: async () => true,
      verdicts,
      managerRuns: async () => managed,
      openPulls,
      list: () => async () => { throw new Error("the workspace has no host credential"); },
      triageState: { load: async (_tenant, key) => ({ rows: ({ [REPO]: waitingRows, [UNREAD]: unreadRows })[key] ?? [], version: null }) },
      now: () => now,
    });
    const app = guardedApp(db, async () => session as never, createInMemoryGrantStore(grants), { triageVerdicts });
    async function get(query = "", headers: Record<string, string> = { "sec-fetch-site": "same-origin" }): Promise<Response> {
      return app.request(`/api/integrations/triage-verdicts/${TENANT}${query}`, { headers });
    }

    // The listing is past 30 seconds old; without the GitHub credential the route keeps using it.
    now = minutes(1);
    const res = await get();
    expect(res.status).toBe(200);
    const body = TriageVerdicts.assert(await res.json());
    const byPull = new Map(body.pulls.map((pull) => [`${pull.repo}#${pull.number}`, pull]));
    // #5 is closed, #4 is in a repository no longer connected, #12 has nothing a person can read; where GitHub could not answer, only a recent verdict or a run is listed, never a note alone.
    expect([...byPull.keys()]).toEqual([`${UNREAD}#2`, `${UNREAD}#4`, `${REPO}#6`, `${REPO}#7`, `${REPO}#8`, `${REPO}#9`, `${REPO}#10`, `${REPO}#11`, `${REPO}#14`]);
    expect(body.triaged).toEqual([{ repo: REPO, source: "github" }, { repo: UNREAD, source: "github" }]);
    expect(body.active).toEqual([{ repo: REPO, source: "github" }, { repo: UNREAD, source: "github" }]);
    expect(body.scored).toBe(false);
    expect(byPull.get(`${REPO}#8`)).toEqual({
      repo: REPO,
      number: 8,
      source: "github",
      activityAt: minutes(4).toISOString(),
      verdict: {
        runId: "run_3", at: minutes(10).toISOString(), headSha: "sha_run_3", verdict: "unsure", settled: true, state: "awaiting-review", actor: "maintainer",
        humanGated: false, degraded: null, commented: false, checks: [{ check: "ci-green", result: "pass" }], detail: DETAIL,
      },
      run: { runId: "run_3", startedAt: minutes(9).toISOString(), status: "failed" },
    });
    expect(byPull.get(`${REPO}#7`)?.verdict?.detail).toBeNull();
    expect(byPull.get(`${REPO}#7`)?.run).toEqual({ status: "waiting-ci", since: minutes(-3).toISOString(), headSha: "sha_waiting" });
    expect(byPull.get(`${REPO}#11`)).toEqual({
      repo: REPO, number: 11, source: "github", activityAt: null, verdict: null, run: null, untriaged: "Couldn't triage: the run never started",
    });
    expect(byPull.get(`${REPO}#9`)).toEqual({
      repo: REPO, number: 9, source: "github", activityAt: minutes(-5).toISOString(), verdict: null, run: { runId: "run_9", startedAt: minutes(-5).toISOString(), status: "running" },
    });
    expect(byPull.get(`${REPO}#10`)?.run?.status).toBe("stuck");
    expect(byPull.get(`${REPO}#6`)?.run?.status).toBe("failed");
    expect(byPull.get(`${REPO}#6`)?.untriaged).toBeUndefined();
    expect(byPull.get(`${UNREAD}#4`)?.untriaged).toBe("Couldn't triage: the run failed");
    expect(byPull.get(`${REPO}#14`)?.untriaged).toBe("Couldn't triage: the run failed");
    // A single read keeps and drops the same notes the list does.
    async function untriagedOf(number: number): Promise<Array<string | undefined>> {
      return TriageVerdicts.assert(await (await get(`?repo=${REPO}&number=${number}`)).json()).pulls.map((pull) => pull.untriaged);
    }
    for (const number of [6, 11, 13, 14]) expect(await untriagedOf(number)).toEqual([byPull.get(`${REPO}#${number}`)?.untriaged]);

    // Polls while nothing changed are answered from memory; a recorded change is read once.
    const etag = res.headers.get("etag")!;
    expect((await get("", { "sec-fetch-site": "same-origin", "if-none-match": etag })).status).toBe(304);
    expect((await get()).status).toBe(200);
    expect(reads).toBe(1);
    managed = observed([...MANAGED.byRepo.get(REPO)!].filter(([key]) => key !== "6@sha6"));
    expect((await get("", { "sec-fetch-site": "same-origin", "if-none-match": etag })).status).toBe(200);
    expect(reads).toBe(2);

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
  });
}, 120_000);

test("PostgreSQL: pull requests of a repository with triage off are listed only while an approval waits on them, though it still counts as triaged", async () => {
  await withDatabase(async function enabledReposOnly(db) {
    const off = "acme/off";
    const config = (enabled: boolean) => ({ corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true }, { name: off, connected: true, enabled }] } });
    await db.insert(schema.tenant).values({ id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config: config(false) });
    await db.insert(schema.principal).values({ id: "prn_verdicts", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage", status: "stopped" });
    await db.insert(schema.workflowRun).values({ id: "run_anchor", anchorRunId: "run_anchor", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed" });
    await db.insert(schema.approval).values({
      id: "apr_held", tenantId: TENANT, anchorRunId: "run_anchor", runId: "run_anchor", agentAddress: "pr-triage@verdicts.test", correlationId: "cor_held",
      toolDefinition: { name: "github_mirror" }, toolArguments: { repo: off, number: 2 },
    });
    const verdicts = createVerdictRecordStore(db);
    await seed(db, TENANT, [verdict("run_on", 1, 0), verdict("run_off", 1, 0, { repo: off }), verdict("run_held", 2, 0, { repo: off })]);
    const openPulls = createOpenPullsCache(() => minutes(0));
    const pr = (number: number) => ({ number, title: `PR ${number}`, author: "ada", draft: false, sha: `sha${number}`, branch: null, updatedAt: minutes(0).toISOString(), labels: [], url: null });
    await openPulls.read(TENANT, async () => [{ repo: REPO, source: "github" as const, prs: [pr(1)] }, { repo: off, source: "github" as const, prs: [pr(1), pr(2)] }]);
    const triageVerdicts = createTriageVerdicts({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      onKeyMoved: noKeyPush,
      authorize: async () => true,
      verdicts,
      managerRuns: async () => NO_RUNS,
      openPulls,
      list: () => async () => { throw new Error("the workspace has no host credential"); },
      triageState: { load: async () => ({ rows: [], version: null }) },
      now: () => minutes(0),
    });
    const grants: GrantRule[] = [{ id: "grt_runs", resource: "workflow-run:*", action: "read", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "prn_verdicts" }];
    const app = guardedApp(db, async () => ({ user: { id: "usr_member" } }) as never, createInMemoryGrantStore(grants), { triageVerdicts });
    async function listed() {
      const res = await app.request(`/api/integrations/triage-verdicts/${TENANT}`, { headers: { "sec-fetch-site": "same-origin" } });
      return TriageVerdicts.assert(await res.json());
    }
    const body = await listed();
    expect(body.pulls.map((pull) => `${pull.repo}#${pull.number}`).sort()).toEqual([`${off}#2`, `${REPO}#1`]);
    expect(body.triaged).toEqual([{ repo: REPO, source: "github" }, { repo: off, source: "github" }]);
    await db.update(schema.tenant).set({ config: config(true) }).where(eq(schema.tenant.id, TENANT));
    expect((await listed()).pulls.map((pull) => `${pull.repo}#${pull.number}`).sort()).toEqual([`${off}#1`, `${off}#2`, `${REPO}#1`]);
  });
}, 120_000);

test("PostgreSQL: a host with no credential costs only its own repositories, while a member barred from a host's credential is refused and leaves the shared listing as it was", async () => {
  await withDatabase(async function hostWithoutCredential(db) {
    const bitbucket = "TRI/widgets";
    const config = { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true }, { name: UNREAD, connected: true, enabled: true }, { name: bitbucket, connected: true, source: "bitbucket-datacenter", enabled: true }] } };
    await db.insert(schema.tenant).values({ id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config });
    await db.insert(schema.principal).values({ id: "prn_verdicts", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" });
    await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: "https://api.github.test" });
    await db.insert(schema.credential).values({
      id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key", secret: "unused", status: "active",
    });
    const verdicts = createVerdictRecordStore(db);
    await seed(db, TENANT, [verdict("run_3", 3, 0)]);
    let now = minutes(0);
    const openPulls = createOpenPullsCache(() => now);
    const listed: string[] = [];
    /** #1's run failed on its open head; #3's failed too, but #3 has a verdict. */
    const noted: PrTriageRow[] = [
      { number: 1, headSha: "sha1", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-1).toISOString(), updatedAt: minutes(-1).toISOString() },
      { number: 3, headSha: "sha3", status: "failed", attempts: 1, error: "run failed", firstSeenAt: minutes(-1).toISOString(), updatedAt: minutes(-1).toISOString() },
    ];
    const deps = {
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      onKeyMoved: noKeyPush,
      async authorize(_principalId: string, _tenantId: string, resource: string) {
        return resource !== "credential:crd_bitbucket";
      },
      openPulls,
      list: () => async function listRepo(record: RepoRecord) {
        listed.push(record.name);
        return [{ number: 1, title: "PR 1", author: "ada", draft: false, sha: "sha1", branch: null, updatedAt: minutes(0).toISOString(), labels: [], url: null, authorAssociation: "MEMBER", authorBot: false }];
      },
    };
    const triageVerdicts = createTriageVerdicts({
      ...deps,
      verdicts,
      managerRuns: async () => NO_RUNS,
      triageState: { load: async (_tenant, key) => ({ rows: key === REPO ? noted : [], version: null }) },
      now: () => now,
    });
    const githubOpenPulls = createGithubOpenPulls({ ...deps, cache: openPulls });
    const grants: GrantRule[] = [{ id: "grt_runs", resource: "workflow-run:*", action: "read", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "prn_verdicts" }];
    const app = guardedApp(db, async () => ({ user: { id: "usr_member" } }) as never, createInMemoryGrantStore(grants), { triageVerdicts, openPulls: githubOpenPulls });
    async function get(path: string): Promise<Response> {
      return app.request(`${path}/${TENANT}`, { headers: { "sec-fetch-site": "same-origin" } });
    }
    async function pullsListed(): Promise<string[]> {
      const res = await get("/api/integrations/triage-verdicts");
      expect(res.status).toBe(200);
      return TriageVerdicts.assert(await res.json()).pulls.map((pull) => `${pull.repo}#${pull.number}`);
    }

    // A single read lists only its own repository, only for a note a verdict does not replace, and within the listing's 30 seconds only once.
    async function single(number: number): Promise<void> {
      expect((await app.request(`/api/integrations/triage-verdicts/${TENANT}?repo=${REPO}&number=${number}`, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
    }
    await single(3);
    expect(listed).toEqual([]);
    await single(1);
    now = minutes(0.1);
    await single(1);
    expect(listed).toEqual([REPO]);
    expect(await pullsListed()).toEqual([`${REPO}#1`]);
    expect(listed).toEqual([REPO, REPO, UNREAD]);
    const res = await get(GITHUB_OPEN_PULLS_PATH);
    expect(res.status).toBe(200);
    const { repos } = await res.json() as { repos: RepoPulls[] };
    expect(repos.map((row) => [row.repo, row.source, row.prs.length, row.error])).toEqual([
      [REPO, "github", 1, undefined],
      [UNREAD, "github", 1, undefined],
      [bitbucket, "bitbucket-datacenter", 0, "Connect Bitbucket Data Center first."],
    ]);

    await db.insert(schema.credential).values({
      id: "crd_bitbucket", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: TOKEN_CREDENTIAL, type: "api_key", secret: "unused", status: "active",
    });
    now = minutes(5);
    const kept = openPulls.kept(TENANT, Infinity);
    const refused = await get(GITHUB_OPEN_PULLS_PATH);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: { code: "forbidden", message: "You do not have access to the Bitbucket Data Center credential." } });
    expect(await pullsListed()).toEqual([`${REPO}#1`]);
    expect(listed).toEqual([REPO, REPO, UNREAD]);
    expect(openPulls.kept(TENANT, Infinity)).toBe(kept);
  });
}, 120_000);

test("PostgreSQL: a re-triage started before a push and done after it does not replace the pushed head's verdict", async () => {
  await withDatabase(async function latestHead(db) {
    await db.insert(schema.tenant).values({ id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config: CONFIG });
    const store = createVerdictRecordStore(db);
    await seed(db, TENANT, [
      verdict("run_backlog", 8, 5, { headSha: "sha_old", startedAt: minutes(0) }),
      verdict("run_push", 8, 3, { headSha: "sha_new", startedAt: minutes(2) }),
    ]);
    expect((await store.latestFor(TENANT, { repo: REPO, number: 8, source: "github" }))?.headSha).toBe("sha_new");
  });
});

test("PostgreSQL: the same repository and number on both hosts come back separately, each with its own verdict, activity, approval and run", async () => {
  await withDatabase(async function bothHosts(db) {
    const off = "acme/off";
    const only = "TRI/only";
    const repos = [REPO, off].flatMap((name) => [{ name, connected: true, enabled: name === REPO }, { name, source: "bitbucket-datacenter", connected: true, enabled: name === REPO }]).concat({ name: only, source: "bitbucket-datacenter", connected: true, enabled: false });
    await db.insert(schema.tenant).values({ id: TENANT, name: "Verdicts", slug: "verdicts", domain: "verdicts.test", config: { corbitsTriage: { repos } } });
    await db.insert(schema.principal).values({ id: "prn_verdicts", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" });
    await db.insert(schema.workflowDefinition).values([
      { id: "wfd_github", tenantId: TENANT, name: TRIAGE_MANAGERS.github, status: "stopped" },
      { id: "wfd_bitbucket", tenantId: TENANT, name: TRIAGE_MANAGERS["bitbucket-datacenter"], status: "stopped" },
    ]);
    await db.insert(schema.workflowRun).values(["run_github", "run_github_off", "run_bitbucket", "run_bitbucket_off"].map((id) => ({
      id, definitionId: id.startsWith("run_github") ? "wfd_github" : "wfd_bitbucket", anchorRunId: id, tenantId: TENANT, status: "completed" as const,
    })));
    await db.insert(schema.approval).values({
      id: "apr_held", tenantId: TENANT, anchorRunId: "run_bitbucket_off", runId: "run_bitbucket_off", agentAddress: "pr-triage@verdicts.test", correlationId: "cor_held",
      toolDefinition: { name: "bitbucket_datacenter_mirror" }, toolArguments: { repo: off, number: 2 },
    });
    const old = -20 * 24 * 60;
    const store = createVerdictRecordStore(db);
    await seed(db, TENANT, [
      verdict("run_github", 8, 0, { trigger: "pull_request:synchronize" }),
      verdict("run_bitbucket", 8, old, { trigger: "issue_comment:created" }),
      verdict("run_github_off", 2, old, { repo: off }),
      verdict("run_bitbucket_off", 2, old, { repo: off }),
    ]);
    let managed = NO_RUNS;
    let listedAt = 0;
    const openPulls = createOpenPullsCache(() => new Date(NOW + listedAt));
    const triageVerdicts = createTriageVerdicts({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      onKeyMoved: noKeyPush,
      authorize: async () => true,
      verdicts: store,
      managerRuns: async () => managed,
      openPulls,
      list: () => async () => { throw new Error("the workspace has no host credential"); },
      triageState: { load: async () => ({ rows: [], version: null }) },
      now: () => minutes(0),
    });
    const grants: GrantRule[] = [{ id: "grt_runs", resource: "workflow-run:*", action: "read", effect: "allow", origin: "system", conditions: null, expiresAt: null, roleId: null, principalId: "prn_verdicts" }];
    const app = guardedApp(db, async () => ({ user: { id: "usr_member" } }) as never, createInMemoryGrantStore(grants), { triageVerdicts });
    async function get(query = ""): Promise<TriageVerdicts> {
      return TriageVerdicts.assert(await (await app.request(`/api/integrations/triage-verdicts/${TENANT}${query}`, { headers: { "sec-fetch-site": "same-origin" } })).json());
    }
    async function listing(at: number, bitbucketError?: string): Promise<void> {
      listedAt = at;
      const pr = (number: number) => ({ ...OPEN[0]!.prs[0]!, number });
      await openPulls.read(TENANT, async () => [REPO, off].flatMap((repo) => [
        { repo, source: "github" as const, prs: [pr(8), pr(2)] },
        { repo, source: "bitbucket-datacenter" as const, prs: bitbucketError === undefined ? [pr(8), pr(2)] : [], ...(bitbucketError !== undefined && { error: bitbucketError }) },
      ]));
    }
    function rows(body: TriageVerdicts) {
      return body.pulls.map((pull) => [pull.source, pull.repo, pull.number, pull.verdict?.runId, pull.activityAt, pull.run?.status ?? null]);
    }

    await listing(0);
    const body = await get();
    expect(rows(body)).toEqual([
      ["bitbucket-datacenter", off, 2, "run_bitbucket_off", null, null],
      ["bitbucket-datacenter", REPO, 8, "run_bitbucket", minutes(old - 1).toISOString(), null],
      ["github", REPO, 8, "run_github", minutes(-1).toISOString(), null],
    ]);
    expect(body.active).toEqual([{ repo: REPO, source: "github" }]);
    expect(body.triaged).toEqual([{ repo: REPO, source: "github" }, { repo: REPO, source: "bitbucket-datacenter" }, { repo: off, source: "github" }, { repo: off, source: "bitbucket-datacenter" }]);

    // Bitbucket could not list: its pull requests come only from the recent window, which its old #8 verdict is outside.
    await listing(1_000, "unreachable");
    expect(rows(await get())).toEqual([["github", REPO, 8, "run_github", minutes(-1).toISOString(), null]]);

    managed = observed([["8@sha_live", [{ ...live("run_bitbucket_live", "running", minutes(-1)), source: "bitbucket-datacenter" as const }]]]);
    await listing(2_000);
    const running = await get();
    expect(rows(running).filter((row) => row[1] === REPO).map((row) => [row[0], row[5]])).toEqual([["bitbucket-datacenter", "running"], ["github", null]]);
    expect(running.active).toEqual([{ repo: REPO, source: "github" }, { repo: REPO, source: "bitbucket-datacenter" }]);
    expect((await get(`?repo=${REPO}&number=8&source=bitbucket-datacenter`)).pulls.map((pull) => pull.verdict?.runId)).toEqual(["run_bitbucket"]);
    expect((await get(`?repo=${REPO}&number=8`)).pulls.map((pull) => pull.verdict?.runId)).toEqual(["run_github"]);

    // A manager up between passes, such as one waiting on a reviewer, runs nothing, so its pull request shows no run.
    const { passAt: _passAt, ...between } = live("run_bitbucket_live", "running", minutes(-1));
    managed = observed([["8@sha_live", [{ ...between, source: "bitbucket-datacenter" as const }]]]);
    expect((await get(`?repo=${REPO}&number=8&source=bitbucket-datacenter`)).pulls.map((pull) => pull.run)).toEqual([null]);
    // One whose reviewers have yet to report is awaiting them.
    managed = observed([["8@sha_live", [{ ...between, source: "bitbucket-datacenter" as const, awaiting: ["judge", "code-review"] }]]]);
    expect((await get(`?repo=${REPO}&number=8&source=bitbucket-datacenter`)).pulls.map((pull) => pull.run)).toEqual([{ runId: "run_bitbucket_live", status: "awaiting", on: ["judge", "code-review"] }]);

    // A name only Bitbucket holds is found without naming its host.
    await db.insert(schema.workflowRun).values({ id: "run_bitbucket_only", definitionId: "wfd_bitbucket", anchorRunId: "run_bitbucket_only", tenantId: TENANT, status: "completed" });
    await seed(db, TENANT, [verdict("run_bitbucket_only", 3, 0, { repo: only })]);
    expect((await get(`?repo=${only}&number=3`)).pulls.map((pull) => [pull.source, pull.verdict?.runId])).toEqual([["bitbucket-datacenter", "run_bitbucket_only"]]);
  });
}, 120_000);
