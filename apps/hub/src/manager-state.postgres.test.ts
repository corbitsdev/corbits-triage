// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { Tx } from "./github/admin-github-grant.js";
import { done, recordEvent, take, type PullRequestRef } from "./manager-state.js";
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
    const reviewer = { kind: "code-review", head: "h2", runId: "run_review", deadline: new Date(Date.now() + 60_000).toISOString() };
    await done(db, TENANT, GITHUB, "run_a", [reviewer]);
    await recordEvent(db, TENANT, GITHUB, "run_review", { type: "reviewer-result", head: "h2", payload: { kind: "code-review", failed: "the review did not finish" } });
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h2" }, request: { kind: "pr", headSha: "h2" }, reviewers: [reviewer] });
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
    const reviewer = { kind: "judge", head: "h1", runId: "run_judge", deadline: new Date(Date.now() - 1_000).toISOString() };
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

test("PostgreSQL: take skips events another transaction holds, keeps the newest head and drops reviewer results for another head", async () => {
  await withDatabase(async function skips(db) {
    await recordEvent(db, TENANT, GITHUB, "d1", webhook("h1"));
    await startManager(db, GITHUB, "run_a");
    expect(await take(db, TENANT, GITHUB, "run_a")).toMatchObject({ outcome: "pass", pass: { head: "h1" } });
    const reviewer = { kind: "judge", head: "h1", runId: "run_judge", deadline: new Date(Date.now() + 60_000).toISOString() };
    expect(await done(db, TENANT, GITHUB, "run_a", [reviewer])).toEqual({ outcome: "more", wait: true });

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
    const later = { kind: "judge", head: "h1", runId: "run_judge", deadline: new Date().toISOString(), toJSON: () => ({}) };
    await expect(done(db, TENANT, GITHUB, "run_a", [later])).rejects.toThrow("are malformed");
    const nullResult = { kind: "judge", head: "h1", runId: "run_judge", deadline: new Date().toISOString(), result: null } as unknown as typeof later;
    await expect(done(db, TENANT, GITHUB, "run_a", [nullResult])).rejects.toThrow("are malformed");
  });
}, 120_000);
