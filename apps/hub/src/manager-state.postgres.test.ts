// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { Tx } from "./github/admin-github-grant.js";
import { done, endNeverRan, liveListener, liveManager, notePlaced, recordEvent, recordResult, take, type PullRequestRef } from "./manager-state.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_manager";
const GITHUB: PullRequestRef = { source: "github", repo: "acme/widgets", number: 7 };
const BITBUCKET: PullRequestRef = { source: "bitbucket-datacenter", repo: "ACME/widgets", number: 7 };
const CLAIM = "mgr:github:acme/widgets#7";
const WAIT_MS = 5_000;

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

/** A live claim naming `runId`, as the run's first take leaves it, without taking any event. */
async function startManager(db: Db, pr: PullRequestRef, runId: string): Promise<void> {
  await liveRun(db, runId);
  const claim = { status: "live", claimId: randomUUID(), claimedAt: new Date().toISOString(), runId, reviewers: [], history: [], starts: 1 };
  await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, ${`mgr:${pr.source}:${pr.repo}#${pr.number}`}, 'claim', ${JSON.stringify(claim)}::jsonb)`);
}

async function stateOf(db: Db, key: string): Promise<Record<string, unknown>> {
  const [row] = await db.execute<{ state: Record<string, unknown> }>(sql`SELECT state FROM corbits_triage.manager_state WHERE key = ${key}`);
  return row.state;
}

type Finish = (tx: Tx) => Promise<void>;

/** Holds `key`'s row lock in another transaction until `release`, which may write under the lock before it commits. */
async function holdRow(db: Db, key: string): Promise<{ release: (finish?: Finish) => Promise<void> }> {
  const released = Promise.withResolvers<Finish | undefined>();
  const held = Promise.withResolvers<void>();
  const holder = db.transaction(async function holdLock(tx) {
    await tx.execute(sql`SELECT 1 FROM corbits_triage.manager_state WHERE key = ${key} FOR UPDATE`);
    held.resolve();
    const finish = await released.promise;
    if (finish) await finish(tx);
  });
  await held.promise;
  return {
    async release(finish?: Finish) {
      released.resolve(finish);
      await holder;
    },
  };
}

async function within<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>(function expire(_, reject) {
    timer = setTimeout(function late() {
      reject(new Error(`still waiting after ${WAIT_MS} ms`));
    }, WAIT_MS);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function untilLockWait(db: Db): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const [row] = await db.execute<{ waiting: number }>(sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (row.waiting > 0) return;
    await Bun.sleep(20);
  }
  throw new Error(`no transaction waited on the held lock within ${WAIT_MS} ms`);
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

test("PostgreSQL: an event a refused manager arrived for is taken by the live one's next pass", async () => {
  await withDatabase(async function drained(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await liveRun(db, "run_a");
    await liveRun(db, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    await recordEvent(db, TENANT, GITHUB, "d2", webhook("h2"));
    expect(await take(db, TENANT, GITHUB, "run_b")).toEqual({ outcome: "refused" });
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "more", wait: false });
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h2", events: ["evt:github:acme/widgets#7:d2"] } });
  });
}, 120_000);

test("PostgreSQL: take answers the pass's newest pull request mail, and on a pass without one the newest recorded", async () => {
  await withDatabase(async function newest(db) {
    const mail = (head: string) => ({ type: "webhook" as const, head, payload: { kind: "pr", headSha: head } });
    await recordEvent(db, TENANT, GITHUB, "d1", mail("h1"));
    await recordEvent(db, TENANT, GITHUB, "d2", mail("h2"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h2" }, request: { kind: "pr", headSha: "h2" } });
    const reviewer = { kind: "code-review", head: "h2", runId: "run_review", deployedBy: "run_a", deadline: new Date(Date.now() + 60_000).toISOString() };
    await done(db, TENANT, GITHUB, "run_a", [reviewer]);
    await recordEvent(db, TENANT, GITHUB, "run_review", { type: "reviewer-result", head: "h2", payload: { kind: "code-review", failed: "the review did not finish" } });
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h2" }, request: { kind: "pr", headSha: "h2" }, reviewers: [reviewer] });
  });
}, 120_000);

test.each([["after"], ["before"]])("PostgreSQL: an approval for an older head recorded %s a push leaves the pass on the push's head and is taken with it", async (order) => {
  await withDatabase(async function approvals(db) {
    const push = { type: "webhook" as const, head: "h2", payload: { kind: "pr", headSha: "h2" } };
    const approval = { type: "webhook" as const, head: "h1", payload: { kind: "approve-do", step: { headSha: "h1" } } };
    for (const [id, event] of order === "after" ? [["d1", push], ["a1", approval]] as const : [["a1", approval], ["d1", push]] as const) await recordEvent(db, TENANT, GITHUB, id, event);
    await startManager(db, GITHUB, "run_a");
    const taken = await take(db, TENANT, GITHUB, "run_a");
    if (taken.outcome !== "pass") throw new Error(`expected a pass, got ${taken.outcome}`);
    expect(taken.pass.head).toBe("h2");
    expect(taken.events.map((row) => row.key).toSorted()).toEqual(["evt:github:acme/widgets#7:a1", "evt:github:acme/widgets#7:d1"]);
    expect(taken.request).toEqual({ kind: "pr", headSha: "h2" });
  });
}, 120_000);

test("PostgreSQL: on a fresh claim an approval alone is a pass, and done then ends the claim", async () => {
  await withDatabase(async function approvalOnly(db) {
    await recordEvent(db, TENANT, GITHUB, "a1", { type: "webhook", head: "h1", payload: { kind: "approve-do", step: { headSha: "h1" } } });
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1", events: ["evt:github:acme/widgets#7:a1"] } });
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "ended" });
  });
}, 120_000);

test("PostgreSQL: done does not wait on a reviewer result take leaves pending for want of a head", async () => {
  await withDatabase(async function headless(db) {
    await recordEvent(db, TENANT, GITHUB, "r1", { type: "reviewer-result", head: "h1", payload: { verdict: "pass" } });
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "idle" });
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "ended" });
  });
}, 120_000);

test("PostgreSQL: a take finds the claim's run gone, takes the claim over and resumes its open pass", async () => {
  await withDatabase(async function takeover(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", resumed: false });
    await liveRun(db, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_b")).toEqual({ outcome: "refused" });

    await db.update(schema.workflowRun).set({ status: "completed" }).where(sql`${schema.workflowRun.id} = 'run_a'`);
    expect(await take(db, TENANT, GITHUB, "run_b")).toMatchObject({ outcome: "pass", resumed: true, pass: { head: "h1", takes: 2 } });
    expect(await stateOf(db, CLAIM)).toMatchObject({ status: "live", runId: "run_b", starts: 2 });
    expect(await take(db, TENANT, GITHUB, "run_a")).toEqual({ outcome: "refused" });
  });
}, 120_000);

test("PostgreSQL: take and done refuse a run the claim does not name", async () => {
  await withDatabase(async function fencing(db) {
    await startManager(db, GITHUB, "run_a");
    await startManager(db, BITBUCKET, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_b")).toEqual({ outcome: "refused" });
    expect(await done(db, TENANT, GITHUB, "run_b", [])).toEqual({ outcome: "refused" });
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "ended" });
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "refused" });
  });
}, 120_000);

test("PostgreSQL: an event is stored with only its own fields and needs a delivery id", async () => {
  await withDatabase(async function eventFields(db) {
    await expect(recordEvent(db, TENANT, GITHUB, "", webhook("h1"))).rejects.toThrow("has no delivery id");
    const consumed = { ...webhook("h1"), consumedBy: "pass_x", consumedAt: new Date().toISOString() };
    expect(await recordEvent(db, TENANT, GITHUB, "d1", consumed)).toBe(true);
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1", events: ["evt:github:acme/widgets#7:d1"] } });
  });
}, 120_000);

test("PostgreSQL: a redelivered event is a no-op", async () => {
  await withDatabase(async function redelivery(db) {
    expect(await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"))).toBe(true);
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    const consumed = await stateOf(db, "evt:github:acme/widgets#7:d1");
    expect(await recordEvent(db, TENANT, GITHUB, "d1", webhook("h2"))).toBe(false);
    expect(await stateOf(db, "evt:github:acme/widgets#7:d1")).toEqual(consumed);
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", resumed: true, pass: { head: "h1", takes: 2 } });
  });
}, 120_000);

test("PostgreSQL: a claim taken again after it ended keeps its history, starts and reviewers", async () => {
  await withDatabase(async function retaken(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass" });
    const reviewer = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_a", deadline: new Date(Date.now() - 1_000).toISOString() };
    expect(await done(db, TENANT, GITHUB, "run_a", [reviewer])).toEqual({ outcome: "ended" });
    const ended = await stateOf(db, CLAIM);

    await liveRun(db, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_b")).toEqual({ outcome: "idle", reviewers: [reviewer] });
    const retaken = await stateOf(db, CLAIM);
    expect(retaken).toMatchObject({ status: "live", runId: "run_b", history: ended["history"], starts: 2, reviewers: [reviewer] });
    expect(retaken["history"]).toMatchObject([{ head: "h1", runId: "run_a" }]);
    expect(retaken["claimId"]).not.toBe(ended["claimId"]);
  });
}, 120_000);

test("PostgreSQL: a manager that posted or mailed takes once more, then the claim ends with its reviewer still out, and the reviewer's result is taken by the next manager", async () => {
  await withDatabase(async function wakeByResult(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    const reviewer = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_a", deadline: new Date(Date.now() + 60_000).toISOString() };
    expect(await done(db, TENANT, GITHUB, "run_a", [reviewer], { wait: true })).toEqual({ outcome: "more", wait: true });
    expect(await take(db, TENANT, GITHUB, "run_a")).toEqual({ outcome: "idle", reviewers: [reviewer] });
    expect(await done(db, TENANT, GITHUB, "run_a", [reviewer])).toEqual({ outcome: "ended" });
    expect(await stateOf(db, CLAIM)).toMatchObject({ status: "ended", reviewers: [reviewer] });

    await recordEvent(db, TENANT, GITHUB, "run_judge", { type: "reviewer-result", head: "h1", payload: { kind: "judge", failed: "the judge did not finish" } });
    await liveRun(db, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_b")).toMatchObject({ outcome: "pass", pass: { head: "h1", events: ["evt:github:acme/widgets#7:run_judge"] }, reviewers: [reviewer] });
    expect(await take(db, TENANT, GITHUB, "run_a")).toEqual({ outcome: "refused" });
  });
}, 120_000);

test("PostgreSQL: a reviewer result is recorded only on the newest head a mail named, judged by the one statement that records it", async () => {
  await withDatabase(async function conditional(db) {
    const result = { kind: "judge", failed: "the judge did not finish" };
    expect(await recordResult(db, TENANT, GITHUB, "run_first", "h0", result)).toEqual({ recorded: true, current: undefined });
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    expect(await recordResult(db, TENANT, GITHUB, "run_stale", "h0", result)).toEqual({ recorded: false, current: "h1" });
    expect(await recordResult(db, TENANT, GITHUB, "run_judge", "h1", result)).toEqual({ recorded: true, current: "h1" });
    expect(await recordResult(db, TENANT, GITHUB, "run_judge", "h1", result)).toEqual({ recorded: false, current: "h1" });
    const rows = await db.execute<{ key: string }>(sql`SELECT key FROM corbits_triage.manager_state WHERE state->>'type' = 'reviewer-result' ORDER BY key`);
    expect(rows.map((row) => row.key)).toEqual(["evt:github:acme/widgets#7:run_first", "evt:github:acme/widgets#7:run_judge"]);
  });
}, 120_000);

test("PostgreSQL: done logs once each reviewer the pass gave up on past its deadline with no report", async () => {
  await withDatabase(async function overdue(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    await take(db, TENANT, GITHUB, "run_a");
    const past = new Date(Date.now() - 1_000).toISOString();
    const silent = { kind: "code-review", head: "h1", runId: "run_silent", deployedBy: "run_a", deadline: past };
    const reported = { ...silent, kind: "judge", runId: "run_reported" };
    const due = { ...silent, runId: "run_due", deadline: new Date(Date.now() + 60_000).toISOString() };
    await done(db, TENANT, GITHUB, "run_a", [silent, reported, due], { wait: true });
    await recordEvent(db, TENANT, GITHUB, "run_reported", { type: "reviewer-result", head: "h1", payload: { kind: "judge", failed: "the judge did not finish" } });
    await take(db, TENANT, GITHUB, "run_a");
    const logged: Record<string, unknown>[] = [];
    function log(entry: Record<string, unknown>): void {
      logged.push(entry);
    }
    await done(db, TENANT, GITHUB, "run_a", [due], { wait: true, log });
    await done(db, TENANT, GITHUB, "run_a", [due], { log });
    expect(logged).toEqual([{ level: "warn", msg: "reviewer_overdue", tenantId: TENANT, ...GITHUB, kind: "code-review", head: "h1", runId: "run_silent", deadline: past }]);
  });
}, 120_000);

test("PostgreSQL: take skips events another transaction holds, keeps the newest head and drops reviewer results for another head", async () => {
  await withDatabase(async function skips(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    const reviewer = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_a", deadline: new Date(Date.now() + 60_000).toISOString() };
    expect(await done(db, TENANT, GITHUB, "run_a", [reviewer], { wait: true })).toEqual({ outcome: "more", wait: true });

    await recordEvent(db, TENANT, GITHUB, "d2", webhook("h2"));
    await recordEvent(db, TENANT, GITHUB, "r1", { type: "reviewer-result", head: "h1", payload: { verdict: "pass" } });
    await recordEvent(db, TENANT, GITHUB, "d3", webhook("h3"));
    const holder = await holdRow(db, "evt:github:acme/widgets#7:d3");
    let first: Awaited<ReturnType<typeof take>>;
    try {
      first = await within(take(db, TENANT, GITHUB, "run_a"));
    } finally {
      await holder.release();
    }
    if (first.outcome !== "pass") throw new Error(`expected a pass, got ${first.outcome}`);
    expect(first.pass).toMatchObject({ head: "h2", events: ["evt:github:acme/widgets#7:d2"] });
    expect(first.events.map((row) => row.key)).toEqual(["evt:github:acme/widgets#7:d2"]);
    expect(await stateOf(db, "evt:github:acme/widgets#7:r1")).toHaveProperty("consumedBy");

    expect(await done(db, TENANT, GITHUB, "run_a", [{ ...reviewer, head: "h2" }])).toEqual({ outcome: "more", wait: false });
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h3", events: ["evt:github:acme/widgets#7:d3"] } });
    expect(await done(db, TENANT, GITHUB, "run_a", [{ ...reviewer, head: "h2" }])).toEqual({ outcome: "ended" });
  });
}, 120_000);

test("PostgreSQL: a reviewer result before the claim's first pass stays pending until a webhook gives it a head", async () => {
  await withDatabase(async function noHead(db) {
    await recordEvent(db, TENANT, GITHUB, "r1", { type: "reviewer-result", head: "h1", payload: { verdict: "pass" } });
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toEqual({ outcome: "idle", reviewers: [] });
    expect(await stateOf(db, "evt:github:acme/widgets#7:r1")).not.toHaveProperty("consumedBy");

    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1", events: ["evt:github:acme/widgets#7:r1", "evt:github:acme/widgets#7:d1"] } });
  });
}, 60_000);

test("PostgreSQL: an event committed while done waits for the claim's lock keeps the manager running", async () => {
  await withDatabase(async function eventFirst(db) {
    await startManager(db, GITHUB, "run_a");
    const holder = await holdRow(db, CLAIM);
    const finishing = done(db, TENANT, GITHUB, "run_a", []);
    try {
      await untilLockWait(db);
      await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    } finally {
      await holder.release();
    }
    expect(await within(finishing)).toEqual({ outcome: "more", wait: false });
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
  });
}, 120_000);

test("PostgreSQL: a take waiting on the claim's lock while the claim ends takes it over", async () => {
  await withDatabase(async function endedWhileWaiting(db) {
    await startManager(db, GITHUB, "run_a");
    await liveRun(db, "run_b");
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    const holder = await holdRow(db, CLAIM);
    const taking = take(db, TENANT, GITHUB, "run_b");
    try {
      await untilLockWait(db);
    } finally {
      await holder.release(async function endClaim(tx) {
        await tx.execute(sql`UPDATE corbits_triage.manager_state SET state = (state - 'runId') || '{"status":"ended"}' WHERE key = ${CLAIM}`);
      });
    }
    expect(await within(taking)).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
  });
}, 120_000);

test("PostgreSQL: an event that arrives after done ends the claim is taken by the next manager", async () => {
  await withDatabase(async function doneFirst(db) {
    await startManager(db, GITHUB, "run_a");
    expect(await done(db, TENANT, GITHUB, "run_a", [])).toEqual({ outcome: "ended" });
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await liveRun(db, "run_b");
    expect(await take(db, TENANT, GITHUB, "run_b")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
  });
}, 120_000);

test("PostgreSQL: a malformed claim fails closed", async () => {
  await withDatabase(async function malformed(db) {
    await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, ${CLAIM}, 'claim', '{"status":"live","runId":"run_a"}')`);
    await expect(take(db, TENANT, GITHUB, "run_a")).rejects.toThrow("is not a claim");

    const ended = { status: "ended", claimId: "c1", claimedAt: new Date().toISOString(), reviewers: [], starts: 1 };
    await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, 'mgr:bitbucket-datacenter:ACME/widgets#7', 'claim', ${JSON.stringify(ended)}::jsonb)`);
    await expect(take(db, TENANT, BITBUCKET, "run_a")).rejects.toThrow("is not a claim");
    expect(await stateOf(db, "mgr:bitbucket-datacenter:ACME/widgets#7")).toEqual(ended);
  });
}, 120_000);

const MINUTE = 60_000;

async function deployedRun(db: Db, runId: string, createdAt: Date): Promise<void> {
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_manager", tenantId: TENANT, status: "deployed", createdAt });
}

async function claimRun(db: Db, runId: string): Promise<void> {
  const claim = { status: "live", claimId: randomUUID(), claimedAt: new Date().toISOString(), runId, reviewers: [], history: [], starts: 1 };
  await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, ${CLAIM}, 'claim', ${JSON.stringify(claim)}::jsonb)`);
}

test("PostgreSQL: a manager deployed without a sidecar past the startup window does not hold the pull request", async () => {
  await withDatabase(async function stuck(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await deployedRun(db, "run_stuck", new Date(Date.now() - 3 * MINUTE));
    await claimRun(db, "run_stuck");
    await liveRun(db, "run_next");
    expect(await take(db, TENANT, GITHUB, "run_next")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    const [left] = await db.select({
      cancellationRequestedAt: schema.workflowRun.cancellationRequestedAt,
      cancellationReason: schema.workflowRun.cancellationReason,
    }).from(schema.workflowRun).where(sql`${schema.workflowRun.id} = 'run_stuck'`);
    expect(left?.cancellationRequestedAt).toBeInstanceOf(Date);
    expect(left?.cancellationReason).toBe("manager deployed without a sidecar or never ran");
  });
}, 120_000);

test("PostgreSQL: a manager deployed inside the startup window, or one with a sidecar, still holds the pull request", async () => {
  await withDatabase(async function held(db) {
    await deployedRun(db, "run_fresh", new Date());
    await claimRun(db, "run_fresh");
    await liveRun(db, "run_next");
    expect(await take(db, TENANT, GITHUB, "run_next")).toEqual({ outcome: "refused" });

    await db.update(schema.workflowRun).set({ createdAt: new Date(Date.now() - 3 * MINUTE) }).where(sql`${schema.workflowRun.id} = 'run_fresh'`);
    await db.insert(schema.sidecar).values({
      id: "sdc_up",
      tokenHashSha256: new Uint8Array(32).fill(7),
      provisionerId: "docker",
      provisionerApiVersion: 2,
      provisionerBindingFingerprint: "fp",
      adapterManifestDigest: "digest",
    });
    await db.insert(schema.sidecarAllocation).values({
      id: "alc_up",
      anchorRunId: "run_fresh",
      tenantId: TENANT,
      provisionerId: "docker",
      provisionerApiVersion: 2,
      provisionerBindingFingerprint: "fp",
      adapterManifestDigest: "digest",
      status: "allocated",
      sidecarId: "sdc_up",
      maxDisconnectedMs: 60_000,
    });
    expect(await take(db, TENANT, GITHUB, "run_next")).toEqual({ outcome: "refused" });
    const [heldRun] = await db.select({ cancellationRequestedAt: schema.workflowRun.cancellationRequestedAt }).from(schema.workflowRun).where(sql`${schema.workflowRun.id} = 'run_fresh'`);
    expect(heldRun?.cancellationRequestedAt).toBeNull();
  });
}, 120_000);

test("PostgreSQL: a manager being cancelled is mailed nothing and takes nothing, but holds the pull request until it ends", async () => {
  await withDatabase(async function cancelling(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_cancelling");
    await db.update(schema.workflowRun).set({ cancellationRequestedAt: new Date(), cancellationDeadline: new Date(), cancellationReason: "unwoken" }).where(sql`${schema.workflowRun.id} = 'run_cancelling'`);
    await liveRun(db, "run_next");
    expect(await liveManager(db, TENANT, GITHUB)).toBeUndefined();
    expect(await take(db, TENANT, GITHUB, "run_cancelling")).toEqual({ outcome: "refused" });
    expect(await take(db, TENANT, GITHUB, "run_next")).toEqual({ outcome: "refused" });
    await db.update(schema.workflowRun).set({ status: "cancelled" }).where(sql`${schema.workflowRun.id} = 'run_cancelling'`);
    expect(await take(db, TENANT, GITHUB, "run_next")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    expect(await stateOf(db, CLAIM)).toMatchObject({ status: "live", runId: "run_next" });
  });
}, 120_000);

async function allocate(db: Db, runId: string, fields: { status: "allocated" | "provisioning"; sidecarId?: string; failureCode?: string }): Promise<void> {
  if (fields.sidecarId !== undefined) {
    await db.insert(schema.sidecar).values({ id: fields.sidecarId, tokenHashSha256: new Uint8Array(32).fill(runId.length), provisionerId: "local-process", provisionerApiVersion: 2, provisionerBindingFingerprint: "fp", adapterManifestDigest: "digest" }).onConflictDoNothing();
  }
  await db.insert(schema.sidecarAllocation).values({ id: `alc_${runId}`, anchorRunId: runId, tenantId: TENANT, provisionerId: "local-process", provisionerApiVersion: 2, provisionerBindingFingerprint: "fp", adapterManifestDigest: "digest", maxDisconnectedMs: 60_000, ...fields });
}

test("PostgreSQL: a manager on its sidecar five minutes without running gives up the pull request, and the reaper ends it but never the listener", async () => {
  await withDatabase(async function neverRan(db) {
    await db.insert(schema.workflowDefinition).values({ id: "wfd_listener", tenantId: TENANT, name: "triage-listener-github" });
    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_listener", tenantId: TENANT, status: "deployed", createdAt: new Date(Date.now() - 60 * MINUTE) });
    await allocate(db, "run_listener", { status: "allocated", sidecarId: "sdc_local" });
    await deployedRun(db, "run_quiet", new Date(Date.now() - 6 * MINUTE));
    await allocate(db, "run_quiet", { status: "allocated", sidecarId: "sdc_local" });
    notePlaced({ allocationId: "alc_run_quiet", generation: 0 }, new Date(Date.now() - 6 * MINUTE));
    await claimRun(db, "run_quiet");
    const logs: Record<string, unknown>[] = [];

    await endNeverRan(db, new Date(), (entry) => logs.push(entry));

    expect(logs).toEqual([{ level: "warn", msg: "triage_deployment_never_ran", runId: "run_quiet", workflow: "triage-manager-github" }]);
    const reasons = await db.select({ id: schema.workflowRun.id, reason: schema.workflowRun.cancellationReason }).from(schema.workflowRun).orderBy(schema.workflowRun.id);
    expect(reasons).toEqual([{ id: "run_listener", reason: null }, { id: "run_quiet", reason: "triage-manager-github deployed but never ran" }]);
    expect(await liveListener(db, TENANT, "github")).toMatchObject({ runId: "run_listener" });
    await liveRun(db, "run_next");
    expect(await take(db, TENANT, GITHUB, "run_next")).toMatchObject({ outcome: "idle" });
  });
}, 120_000);

test("PostgreSQL: a manager that waited past five minutes for a slot is timed from its placement, not its deploy", async () => {
  await withDatabase(async function placedLate(db) {
    await deployedRun(db, "run_late", new Date(Date.now() - 10 * MINUTE));
    await allocate(db, "run_late", { status: "allocated", sidecarId: "sdc_local" });
    notePlaced({ allocationId: "alc_run_late", generation: 0 }, new Date(Date.now() - MINUTE));
    await claimRun(db, "run_late");
    const logs: Record<string, unknown>[] = [];

    await endNeverRan(db, new Date(), (entry) => logs.push(entry));

    expect(logs).toEqual([]);
    await liveRun(db, "run_next");
    expect(await take(db, TENANT, GITHUB, "run_next")).toEqual({ outcome: "refused" });
  });
}, 120_000);

test("PostgreSQL: a manager whose placement waits for a free slot keeps the pull request for half an hour", async () => {
  await withDatabase(async function waiting(db) {
    await deployedRun(db, "run_waiting", new Date(Date.now() - 10 * MINUTE));
    await allocate(db, "run_waiting", { status: "provisioning", failureCode: "sidecar_reuse_rejected" });
    await claimRun(db, "run_waiting");
    await liveRun(db, "run_next");
    expect(await take(db, TENANT, GITHUB, "run_next")).toEqual({ outcome: "refused" });

    await db.update(schema.workflowRun).set({ createdAt: new Date(Date.now() - 31 * MINUTE) }).where(sql`${schema.workflowRun.id} = 'run_waiting'`);
    expect(await take(db, TENANT, GITHUB, "run_next")).toMatchObject({ outcome: "idle" });
  });
}, 120_000);

test("PostgreSQL: a listener counts as live as a manager does, and one deployed without a sidecar past the startup window is released", async () => {
  await withDatabase(async function listener(db) {
    await db.insert(schema.workflowDefinition).values({ id: "wfd_listener", tenantId: TENANT, name: "triage-listener-github" });
    await db.insert(schema.workflowRun).values({ id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_listener", tenantId: TENANT, status: "deployed", createdAt: new Date() });
    expect(await liveListener(db, TENANT, "github")).toMatchObject({ runId: "run_listener" });
    expect(await liveListener(db, TENANT, "bitbucket-datacenter")).toBeUndefined();
    await db.update(schema.workflowRun).set({ createdAt: new Date(Date.now() - 7 * MINUTE) }).where(sql`${schema.workflowRun.id} = 'run_listener'`);
    expect(await liveListener(db, TENANT, "github")).toBeUndefined();
    const [left] = await db.select({ cancellationRequestedAt: schema.workflowRun.cancellationRequestedAt, cancellationReason: schema.workflowRun.cancellationReason }).from(schema.workflowRun).where(sql`${schema.workflowRun.id} = 'run_listener'`);
    expect(left?.cancellationRequestedAt).toBeInstanceOf(Date);
    expect(left?.cancellationReason).toBe("listener deployed without a sidecar");
  });
}, 120_000);

test("PostgreSQL: while a roll waits for a new listener to start, pull requests go to the running one and the new one is not released", async () => {
  await withDatabase(async function swap(db) {
    await db.insert(schema.workflowDefinition).values({ id: "wfd_listener", tenantId: TENANT, name: "triage-listener-github" });
    await db.insert(schema.workflowRun).values([
      { id: "run_old", anchorRunId: "run_old", definitionId: "wfd_listener", tenantId: TENANT, status: "running", createdAt: new Date(Date.now() - 60 * MINUTE) },
      { id: "run_new", anchorRunId: "run_new", definitionId: "wfd_listener", tenantId: TENANT, status: "deployed", createdAt: new Date(Date.now() - 4 * MINUTE) },
    ]);
    expect(await liveListener(db, TENANT, "github")).toMatchObject({ runId: "run_old" });
    const [waiting] = await db.select({ cancellationRequestedAt: schema.workflowRun.cancellationRequestedAt }).from(schema.workflowRun).where(sql`${schema.workflowRun.id} = 'run_new'`);
    expect(waiting?.cancellationRequestedAt).toBeNull();
    await db.update(schema.workflowRun).set({ status: "running" }).where(sql`${schema.workflowRun.id} = 'run_new'`);
    expect(await liveListener(db, TENANT, "github")).toMatchObject({ runId: "run_new" });
  });
}, 120_000);

test("PostgreSQL: a malformed event payload or reviewer is refused", async () => {
  await withDatabase(async function badPayload(db) {
    await startManager(db, GITHUB, "run_a");
    for (const payload of [undefined, new Date(), [1]]) {
      const event = { type: "webhook", head: "h1", payload } as unknown as ReturnType<typeof webhook>;
      await expect(recordEvent(db, TENANT, GITHUB, "d1", event)).rejects.toThrow("is not an event");
    }
    const [stored] = await db.execute<{ events: number }>(sql`SELECT count(*)::int AS events FROM corbits_triage.manager_state WHERE kind = 'event'`);
    expect(stored.events).toBe(0);
    expect(await take(db, TENANT, GITHUB, "run_a")).toEqual({ outcome: "idle", reviewers: [] });
    const later = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_a", deadline: new Date().toISOString(), toJSON: () => ({}) };
    await expect(done(db, TENANT, GITHUB, "run_a", [later])).rejects.toThrow("are malformed");
    const nullResult = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_a", deadline: new Date().toISOString(), result: null } as unknown as typeof later;
    await expect(done(db, TENANT, GITHUB, "run_a", [nullResult])).rejects.toThrow("are malformed");
  });
}, 120_000);
