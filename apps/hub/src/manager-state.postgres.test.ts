// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { authorGroupsOf, readCheckPack, readPolicyFile } from "@corbits/triage-contracts";
import { closeOutDue, done, endNeverRan, notePlaced, recordEvent, take, type PullRequestRef } from "./manager-state.js";
import { timings } from "./timings.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_manager";
const GITHUB: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const CLAIM = "mgr:github:acme/widgets#7";

type Db = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_manager_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Manager", slug: "manager", domain: "manager.test" });
    await handle.db.insert(schema.workflowDefinition).values({ id: "wfd_manager", tenantId: TENANT, name: "triage-manager-github" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function webhook(head: string) {
  return { type: "webhook" as const, head, payload: { action: "synchronize" } };
}

async function liveRun(db: Db, runId: string): Promise<void> {
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, status: "running" });
}

async function stateOf(db: Db, key: string): Promise<Record<string, unknown>> {
  const [row] = await db.execute<{ state: Record<string, unknown> }>(sql`SELECT state FROM corbits_triage.manager_state WHERE key = ${key}`);
  return row.state;
}

test("PostgreSQL: of two managers racing take for one pull request one claims it and takes its events, and the other is refused", async () => {
  await withDatabase(async function race(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await liveRun(db, "run_a");
    await liveRun(db, "run_b");
    const takes = await Promise.all([take(db, TENANT, GITHUB, "run_a"), take(db, TENANT, GITHUB, "run_b")]);
    expect(takes.map((taken) => taken.outcome).toSorted()).toEqual(["pass", "refused"]);
    const winner = takes[0].outcome === "pass" ? "run_a" : "run_b";
    expect(await stateOf(db, CLAIM)).toMatchObject({ status: "live", runId: winner, starts: 1 });
  });
}, 120_000);
/** A live claim naming `runId`, as the run's first take leaves it, without taking any event. */
async function startManager(db: Db, pr: PullRequestRef, runId: string): Promise<void> {
  await liveRun(db, runId);
  const claim = { status: "live", claimId: randomUUID(), claimedAt: new Date().toISOString(), runId, reviewers: [], history: [], starts: 1 };
  await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, ${`mgr:${pr.source}:${pr.repo}#${pr.number}`}, 'claim', ${JSON.stringify(claim)}::jsonb)`);
}

function prMail(head: string, events?: string[]) {
  return { type: "webhook" as const, head, payload: { kind: "pr", headSha: head, ...(events && { events }) } };
}

test("PostgreSQL: a close is due only while a manager is on the pull request or the last pass on its head posted no verdict", async () => {
  await withDatabase(async function closing(db) {
    expect(await closeOutDue(db, TENANT, GITHUB, "h1")).toBe(false);
    await startManager(db, GITHUB, "run_a");
    expect(await closeOutDue(db, TENANT, GITHUB, "h1")).toBe(true);
    await recordEvent(db, TENANT, GITHUB, "d1", prMail("h1", ["opened"]));
    await take(db, TENANT, GITHUB, "run_a");
    expect(await done(db, TENANT, GITHUB, "run_a", [], { report: { head: "h1", waiting: true } })).toEqual({ outcome: "ended" });
    expect(await closeOutDue(db, TENANT, GITHUB, "h1")).toBe(true);
    await recordEvent(db, TENANT, GITHUB, "d2", prMail("h1", ["checks"]));
    await take(db, TENANT, GITHUB, "run_a");
    expect(await done(db, TENANT, GITHUB, "run_a", [], { report: { head: "h1", request: { comment: "Triage: Pass" } } })).toEqual({ outcome: "ended" });
    expect(await closeOutDue(db, TENANT, GITHUB, "h1")).toBe(false);
    expect(await closeOutDue(db, TENANT, GITHUB, "h2")).toBe(true);
  });
}, 120_000);

const MINUTE = 60_000;

async function deployedRun(db: Db, runId: string, createdAt: Date): Promise<void> {
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, status: "deployed", createdAt });
}

async function allocate(db: Db, runId: string, fields: { status: "allocated"; sidecarId: string }): Promise<void> {
  await db.insert(schema.sidecar).values({ id: fields.sidecarId, tokenHashSha256: new Uint8Array(32).fill(runId.length), provisionerId: "local-process", provisionerApiVersion: 2, provisionerBindingFingerprint: "fp", adapterManifestDigest: "digest" }).onConflictDoNothing();
  await db.insert(schema.sidecarAllocation).values({ id: `alc_${runId}`, anchorRunId: runId, tenantId: TENANT, provisionerId: "local-process", provisionerApiVersion: 2, provisionerBindingFingerprint: "fp", adapterManifestDigest: "digest", maxDisconnectedMs: 60_000, ...fields });
}

test("PostgreSQL: a cancel that fails is logged and the reaper still ends the next run that never ran", async () => {
  await withDatabase(async function cancelFails(db) {
    const deployedAt = new Date(Date.now() - timings().mailHoldMs - MINUTE);
    for (const [runId, sidecarId] of [["run_a", "sdc_a"], ["run_bb", "sdc_b"]]) {
      await deployedRun(db, runId, deployedAt);
      await allocate(db, runId, { status: "allocated", sidecarId });
      notePlaced({ allocationId: `alc_${runId}`, generation: 0 }, deployedAt);
    }
    const attempted: string[] = [];
    const logs: Record<string, unknown>[] = [];

    await endNeverRan(db, new Date(), async function cancel(_, runId) {
      attempted.push(runId);
      if (attempted.length === 1) throw new Error("cancel refused");
    }, (entry) => logs.push(entry));

    expect(attempted.toSorted()).toEqual(["run_a", "run_bb"]);
    expect(logs).toContainEqual({ level: "error", msg: "triage_never_ran_cancel_failed", tenantId: TENANT, runId: attempted[0], error: "Error: cancel refused" });
  });
}, 120_000);

test("PostgreSQL: a pull request's mail keeps the policy's group order, so an author is in the first group the file lists that they match", async () => {
  const policy = readPolicyFile("rules: []\ngroups:\n  approved: { users: [octocat] }\n  outside: { association: [CONTRIBUTOR] }\n", GITHUB.repo);
  await withDatabase(async function stored(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", { type: "webhook", head: "h1", payload: { kind: "pr", headSha: "h1", pack: policy } });
    await liveRun(db, "run_a");
    const taken = await take(db, TENANT, GITHUB, "run_a");
    if (taken.outcome !== "pass") throw new Error(`take answered ${taken.outcome}`);
    const pack = readCheckPack(taken.events[0].event.payload.pack, GITHUB.repo);
    const author = { login: "octocat", kind: "CONTRIBUTOR" as const, teams: [] };
    expect(authorGroupsOf(pack.groups ?? [], author)).toEqual(["approved", "external", "everyone"]);
    await recordEvent(db, TENANT, GITHUB, "d2", { type: "webhook", head: "h2", payload: { kind: "pr", headSha: "h2", pack: { ...policy, groups: { approved: { users: ["octocat"] }, outside: { association: ["CONTRIBUTOR"] } } } } });
    const [stored] = await db.execute<{ state: { payload: { pack: unknown } } }>(sql`SELECT state FROM corbits_triage.manager_state WHERE key LIKE ${"%d2"}`);
    expect(() => readCheckPack(stored.state.payload.pack, GITHUB.repo)).toThrow("stored before Triage kept group order");
  });
}, 120_000);

test("PostgreSQL: a completed review refreshes reused threads even after the first pass on its head", async () => {
  await withDatabase(async function reusedThread(db) {
    for (const source of ["github", "bitbucket-datacenter"] as const) {
      const pr = { ...GITHUB, source };
      const run = `run_${source}`;
      await liveRun(db, run);
      await recordEvent(db, TENANT, pr, "push", webhook("new"));
      expect((await take(db, TENANT, pr, run)).outcome).toBe("pass");
      await done(db, TENANT, pr, run, [], { wait: true });
      const result = { summary: "", complete: true, budgetExhausted: false, comments: [{ path: "a.ts", start: 1, end: 1, title: "Still present", body: "Same defect", priority: 2, thread: { id: 501, state: "resolved" } }] };
      await recordEvent(db, TENANT, pr, "review", { type: "reviewer-result", head: "new", payload: { kind: "code-review", result } });
      const taken = await take(db, TENANT, pr, run);
      expect(taken).toMatchObject({ outcome: "pass", threads: [501] });
    }
  });
}, 120_000);
