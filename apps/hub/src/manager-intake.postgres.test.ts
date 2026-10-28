// Requires PostgreSQL at TEST_DB. The listener path against a real store, with the host read and the mail recorded.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { APPROVE_DO_KIND, emptyPack, repoPolicy } from "@corbits/triage-contracts";
import type { PullRequestToReview } from "./pull-request-reader.js";
import { mailPayload } from "./github/bridge.js";
import { createPauseGate } from "./github/pr-workflow.js";
import { createManagerIntake, createManagerWake, createOverdueWake, createSupersede } from "./manager-intake.js";
import { ListenerUnroutedError, RunUnavailableError } from "./github/deployment.js";
import { recordEvent } from "./manager-state.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_intake";
const LISTENER = "run_listener@intake.test";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
const POLICY = repoPolicy(RECORD);
const STORED = { pack: emptyPack(RECORD.name), automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } };
const PULL: PullRequestToReview = { headSha: "h1", open: true, draft: false, title: "Add the flag", description: "Adds it.", labels: [], diff: "diff --git a/f b/f\n+x" };

type Db = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_intake_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Intake", slug: "intake", domain: "intake.test", config: { corbitsTriage: { repos: [RECORD] } } });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

type Gate = Parameters<typeof createManagerIntake>[0]["gate"];

async function passed(_tenantId: string, _record: unknown, _number: number, request: Record<string, unknown>) {
  return request;
}

const OPEN = [{ number: 7, headSha: "h1", draft: false }, { number: 9, headSha: "h9", draft: true }];

function stack(db: Db, listener: string | undefined, pull = PULL, gate: Gate = passed, open = OPEN, routable = true) {
  const mailed: { address: string; payload: unknown }[] = [];
  const logged: Record<string, unknown>[] = [];
  const cancelled: { runId: string; reason: string }[] = [];
  const refusing = new Set<string>();
  const { supersede, supersedeAll } = createSupersede({
    db,
    async cancel(_tenantId, runId, reason) {
      if (refusing.has(runId)) throw new Error("cancel failed");
      cancelled.push({ runId, reason });
    },
    log: (entry) => logged.push(entry),
  });
  const toListener = createManagerIntake({
    db,
    listener: async () => listener,
    routable: async () => routable,
    readPull: async () => pull,
    openHeads: async () => open,
    withAppLogin: async (_tenantId, payload) => ({ ...payload, appLogin: "triage[bot]" }),
    async deliver(_tenantId, address, payload) {
      if (!routable) throw new RunUnavailableError("the listener is not running");
      mailed.push({ address, payload });
    },
    supersede,
    gate,
    log: (entry) => logged.push(entry),
  });
  return { toListener, mailed, logged, cancelled, refusing, supersedeAll };
}

async function events(db: Db): Promise<{ key: string; state: { head: string; payload: Record<string, unknown> } }[]> {
  return db.execute(sql`SELECT key, state FROM corbits_triage.manager_state WHERE kind = 'event' ORDER BY key`);
}

/** The reconciler's mail for a requeued head, naming it as `items`. */
function requeued(number: number, headSha: string) {
  return mailPayload(RECORD, POLICY, STORED, { items: [{ prNumber: number, headSha }] });
}

test("PostgreSQL: a workspace without a listener records nothing and mails nothing, so its pull requests route as today", async () => {
  await withDatabase(async function noListener(db) {
    const { toListener, mailed } = stack(db, undefined);
    expect(await toListener(TENANT, mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h1" }))).toBe(false);
    expect({ events: (await events(db)).length, mailed }).toEqual({ events: 0, mailed: [] });
  });
}, 60_000);

test("PostgreSQL: mail for a pull request with no manager up, while the hub holds no route to the listener, records and mails nothing", async () => {
  await withDatabase(async function unrouted(db) {
    const { toListener, mailed } = stack(db, LISTENER, PULL, passed, OPEN, false);
    await expect(toListener(TENANT, requeued(7, "h1"))).rejects.toBeInstanceOf(ListenerUnroutedError);
    expect({ events: (await events(db)).length, mailed }).toEqual({ events: 0, mailed: [] });
  });
}, 60_000);

test("PostgreSQL: a held Do's approval while the hub holds no route to the listener is recorded, so the manager the listener later starts for the head runs it", async () => {
  await withDatabase(async function approvedInGap(db) {
    const { toListener, mailed } = stack(db, LISTENER, PULL, passed, OPEN, false);
    const approval = { kind: APPROVE_DO_KIND, runId: "run_m", principalId: "prn_a", list: "pass", index: 0, request: { repo: RECORD.name, number: 7 }, step: { effectId: "e1", headSha: "h1" } };
    await expect(toListener(TENANT, approval)).rejects.toBeInstanceOf(ListenerUnroutedError);
    expect({ events: (await events(db)).map((row) => `${row.state.head} ${String(row.state.payload["kind"])}`), mailed }).toEqual({ events: ["h1 approve-do"], mailed: [] });
  });
}, 60_000);

test("PostgreSQL: each pull request a mail names is recorded as its own event, a webhook once however often it is delivered and any other mail every time, and the listener is mailed the heads", async () => {
  await withDatabase(async function listener(db) {
    const { toListener, mailed } = stack(db, LISTENER);
    const webhook = mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h1", deliveryId: "d1" });
    expect(await toListener(TENANT, webhook)).toBe(true);
    expect(await toListener(TENANT, webhook)).toBe(true);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    const approval = { kind: APPROVE_DO_KIND, runId: "run_m", principalId: "prn_a", list: "pass", index: 0, request: { repo: RECORD.name, number: 7 }, step: { effectId: "e1", headSha: "h1" } };
    expect(await toListener(TENANT, approval)).toBe(true);
    expect(await toListener(TENANT, { ...mailPayload(RECORD, POLICY, STORED, {}), kind: "backlog" })).toBe(true);
    expect(await toListener(TENANT, { kind: "history", repo: RECORD.name })).toBe(false);

    const recorded = await events(db);
    expect(recorded.map((row) => `${row.key.split(":").slice(0, 3).join(":")} ${row.state.head} ${String(row.state.payload["kind"])}`).toSorted()).toEqual([
      "evt:github:acme/widgets#7 h1 approve-do",
      "evt:github:acme/widgets#7 h1 pr",
      "evt:github:acme/widgets#7 h1 pr",
      "evt:github:acme/widgets#7 h1 pr",
      "evt:github:acme/widgets#7 h1 pr",
    ]);
    expect(recorded.map((row) => row.key)).toContain("evt:github:acme/widgets#7:d1");
    const item = recorded.find((row) => row.state.payload["kind"] === "pr" && row.state.payload["deliveryId"] === undefined)!;
    expect(item.state.payload).toMatchObject({ prNumber: 7, headSha: "h1", appLogin: "triage[bot]" });
    expect(item.state.payload).not.toHaveProperty("items");
    expect(mailed.map((mail) => mail.address)).toEqual(Array(6).fill(LISTENER));
    expect(mailed[0]!.payload).toEqual({ kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 7, headSha: "h1" }] });
  });
}, 60_000);

async function claimManager(db: Db, runId: string, number: number, status: "running" | "deployed" | "completed", createdAt?: Date, reviewers: object[] = []): Promise<void> {
  await db.insert(schema.workflowDefinition).values({ id: "wfd_intake", tenantId: TENANT, name: "triage-manager-github" }).onConflictDoNothing();
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_intake", tenantId: TENANT, status, ...(createdAt && { createdAt }) });
  const claim = { status: "live", claimId: `claim-${runId}`, claimedAt: new Date().toISOString(), runId, reviewers, history: [], starts: 1 };
  await db.execute(sql`INSERT INTO corbits_triage.manager_state (tenant_id, key, kind, state) VALUES (${TENANT}, ${`mgr:github:${RECORD.name}#${number}`}, 'claim', ${JSON.stringify(claim)}::jsonb)`);
}

test("PostgreSQL: a pull request whose manager is up is mailed that manager, and one with none is mailed to the listener", async () => {
  await withDatabase(async function reuse(db) {
    await claimManager(db, "run_mgr", 7, "running");
    const { toListener, mailed } = stack(db, LISTENER);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    expect(await toListener(TENANT, mailPayload(RECORD, POLICY, STORED, { items: [{ prNumber: 7, headSha: "h1" }, { prNumber: 8, headSha: "h8" }] }))).toBe(true);
    expect(mailed).toEqual([
      { address: "run_mgr@intake.test", payload: { kind: "manage", tenantId: TENANT, repo: RECORD.name, repoSource: "github", prNumber: 7 } },
      { address: "run_mgr@intake.test", payload: { kind: "manage", tenantId: TENANT, repo: RECORD.name, repoSource: "github", prNumber: 7 } },
      { address: LISTENER, payload: { kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 8, headSha: "h8" }] } },
    ]);
  });
}, 60_000);

test("PostgreSQL: a reviewer's result wakes the pull request's live manager, or has the listener deploy one once its claim ended, and none without a listener", async () => {
  await withDatabase(async function wake(db) {
    await claimManager(db, "run_mgr", 7, "running");
    const mailed: { address: string; payload: unknown }[] = [];
    function waker(listener: string | undefined) {
      return createManagerWake({
        db,
        listener: async () => listener,
        async deliver(_tenantId, address, payload) {
          mailed.push({ address, payload });
        },
      });
    }
    const pr = { source: "github" as const, repo: RECORD.name, number: 7 };
    expect(await waker(LISTENER)(TENANT, pr, "h1")).toBe(true);
    await db.execute(sql`UPDATE corbits_triage.manager_state SET state = (state - 'runId') || '{"status":"ended"}' WHERE kind = 'claim'`);
    expect(await waker(LISTENER)(TENANT, pr, "h1")).toBe(true);
    expect(await waker(undefined)(TENANT, pr, "h1")).toBe(false);
    expect(mailed).toEqual([
      { address: "run_mgr@intake.test", payload: { kind: "manage", tenantId: TENANT, repo: RECORD.name, repoSource: "github", prNumber: 7 } },
      { address: LISTENER, payload: { kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 7, headSha: "h1" }] } },
    ]);
  });
}, 60_000);

test("PostgreSQL: a push stops the judge and the code review still out on the older head, once each, and one whose stop failed stays on the claim until a reconcile pass stops it", async () => {
  await withDatabase(async function superseded(db) {
    const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
    const judge = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_old", deadline };
    const review = { ...judge, kind: "code-review", runId: "run_review" };
    const current = { ...judge, head: "h2", runId: "run_current" };
    await claimManager(db, "run_old", 7, "completed", undefined, [judge, review, current]);
    const { toListener, cancelled, logged, refusing, supersedeAll } = stack(db, LISTENER);
    async function held(): Promise<unknown[]> {
      const [claim] = await db.execute<{ state: { reviewers: unknown[] } }>(sql`SELECT state FROM corbits_triage.manager_state WHERE kind = 'claim'`);
      return claim!.state.reviewers;
    }
    const where = { tenantId: TENANT, source: "github", repo: RECORD.name, number: 7 };
    refusing.add("run_review");
    expect(await toListener(TENANT, mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h2", deliveryId: "push-1" }))).toBe(true);
    expect(cancelled).toEqual([{ runId: "run_judge", reason: "superseded by a newer head" }]);
    expect(await held()).toEqual([review, current]);
    expect(logged.filter((entry) => entry["msg"] === "reviewer_supersede_failed")).toEqual([{ level: "error", msg: "reviewer_supersede_failed", ...where, kind: "code-review", head: "h1", runId: "run_review", error: "Error: cancel failed" }]);

    refusing.clear();
    await supersedeAll(TENANT);
    expect(await toListener(TENANT, mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h2", deliveryId: "push-2" }))).toBe(true);
    expect(cancelled).toEqual([{ runId: "run_judge", reason: "superseded by a newer head" }, { runId: "run_review", reason: "superseded by a newer head" }]);
    expect(logged.filter((entry) => entry["msg"] === "reviewer_superseded")).toEqual([
      { level: "info", msg: "reviewer_superseded", ...where, kind: "judge", head: "h1", runId: "run_judge" },
      { level: "info", msg: "reviewer_superseded", ...where, kind: "code-review", head: "h1", runId: "run_review" },
    ]);
    expect(await held()).toEqual([current]);
  });
}, 60_000);

test("PostgreSQL: the reconcile pass wakes a manager for a pull request whose reviewer of its newest head is past its deadline with no result and no manager up", async () => {
  await withDatabase(async function overdue(db) {
    const past = new Date(Date.now() - 60_000).toISOString();
    const late = { kind: "judge", head: "h1", runId: "run_judge", deployedBy: "run_gone", deadline: past };
    await claimManager(db, "run_gone", 7, "completed", undefined, [late]);
    await claimManager(db, "run_up", 8, "running", undefined, [{ ...late, runId: "run_judge_8" }]);
    await claimManager(db, "run_reported", 9, "completed", undefined, [{ ...late, runId: "run_judge_9" }]);
    for (const number of [7, 8, 9]) await recordEvent(db, TENANT, { source: "github", repo: RECORD.name, number }, `d${number}`, { type: "webhook", head: "h1", payload: { kind: "pr", headSha: "h1" } });
    await recordEvent(db, TENANT, { source: "github", repo: RECORD.name, number: 9 }, "run_judge_9", { type: "reviewer-result", head: "h1", payload: { kind: "judge", failed: "the judge did not finish" } });
    await db.execute(sql`UPDATE corbits_triage.manager_state SET state = state || '{"consumedBy":"pass_9"}' WHERE kind = 'event' AND key LIKE '%:run_judge_9'`);
    const mailed: { address: string; payload: unknown }[] = [];
    const logged: Record<string, unknown>[] = [];
    const wake = createManagerWake({
      db,
      listener: async () => LISTENER,
      async deliver(_tenantId, address, payload) {
        mailed.push({ address, payload });
      },
    });
    const wakeOverdue = createOverdueWake({ db, wake, log: (entry) => logged.push(entry) });
    await wakeOverdue(TENANT);
    await wakeOverdue(TENANT);
    const woken = { address: LISTENER, payload: { kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 7, headSha: "h1" }] } };
    expect(mailed).toEqual([woken]);
    expect(logged).toEqual([{ level: "info", msg: "manager_woken_overdue", tenantId: TENANT, source: "github", repo: RECORD.name, number: 7, head: "h1" }]);

    // A manager the wake started took the claim and went away before done; past the start grace the next pass wakes again.
    const earlier = new Date(Date.now() - 3 * 60_000);
    await db.execute(sql`UPDATE corbits_triage.manager_state SET state = state || ${JSON.stringify({ overdueWokenAt: earlier.toISOString(), claimedAt: new Date(earlier.getTime() + 1_000).toISOString() })}::jsonb WHERE key = ${`mgr:github:${RECORD.name}#7`}`);
    await wakeOverdue(TENANT);
    expect(mailed).toEqual([woken, woken]);
  });
}, 60_000);

async function overdueWokenAt(db: Db, number: number): Promise<unknown> {
  const [claim] = await db.execute<{ state: Record<string, unknown> }>(sql`SELECT state FROM corbits_triage.manager_state WHERE key = ${`mgr:github:${RECORD.name}#${number}`}`);
  return claim!.state["overdueWokenAt"];
}

test("PostgreSQL: an overdue wake is recorded only once it succeeded, and one pull request whose wake fails is logged while the next is still woken", async () => {
  await withDatabase(async function partly(db) {
    const late = { kind: "judge", head: "h1", runId: "run_judge_7", deployedBy: "run_gone_7", deadline: new Date(Date.now() - 60_000).toISOString() };
    await claimManager(db, "run_gone_7", 7, "completed", undefined, [late]);
    await claimManager(db, "run_gone_8", 8, "completed", undefined, [{ ...late, runId: "run_judge_8" }]);
    for (const number of [7, 8]) await recordEvent(db, TENANT, { source: "github", repo: RECORD.name, number }, `d${number}`, { type: "webhook", head: "h1", payload: { kind: "pr", headSha: "h1" } });
    const woken: number[] = [];
    const logged: Record<string, unknown>[] = [];
    let failing = true;
    async function wake(_tenantId: string, pr: { number: number }): Promise<boolean> {
      if (pr.number === 7 && failing) throw new Error("delivery failed");
      woken.push(pr.number);
      return true;
    }
    const wakeOverdue = createOverdueWake({ db, wake, log: (entry) => logged.push(entry) });
    await wakeOverdue(TENANT);
    expect(woken).toEqual([8]);
    expect(logged).toEqual([
      { level: "error", msg: "manager_overdue_wake_failed", tenantId: TENANT, source: "github", repo: RECORD.name, number: 7, head: "h1", error: "Error: delivery failed" },
      { level: "info", msg: "manager_woken_overdue", tenantId: TENANT, source: "github", repo: RECORD.name, number: 8, head: "h1" },
    ]);
    expect(await overdueWokenAt(db, 7)).toBeUndefined();
    expect(await overdueWokenAt(db, 8)).toBeString();

    failing = false;
    await wakeOverdue(TENANT);
    expect(woken).toEqual([8, 7]);

    const unrouted = createOverdueWake({ db, wake: async () => false, log: (entry) => logged.push(entry) });
    await claimManager(db, "run_gone_9", 9, "completed", undefined, [{ ...late, runId: "run_judge_9" }]);
    await recordEvent(db, TENANT, { source: "github", repo: RECORD.name, number: 9 }, "d9", { type: "webhook", head: "h1", payload: { kind: "pr", headSha: "h1" } });
    await unrouted(TENANT);
    expect(await overdueWokenAt(db, 9)).toBeUndefined();
  });
}, 60_000);

test("PostgreSQL: a manager deployed without a sidecar past the startup window is not mailed, and the listener is", async () => {
  await withDatabase(async function stuck(db) {
    await claimManager(db, "run_stuck", 7, "deployed", new Date(Date.now() - 3 * 60_000));
    const { toListener, mailed } = stack(db, LISTENER);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    expect(mailed).toEqual([{ address: LISTENER, payload: { kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 7, headSha: "h1" }] } }]);
  });
}, 60_000);

test("PostgreSQL: with code review on, the recorded mail carries the head's review request", async () => {
  await withDatabase(async function reviewed(db) {
    const { toListener } = stack(db, LISTENER);
    expect(await toListener(TENANT, { ...mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h1" }), codeReview: { on: true } })).toBe(true);
    const [row] = await events(db);
    expect(row!.state.payload).toMatchObject({ codeReviewRequest: { kind: "code-review", number: 7, title: PULL.title, checkout: { source: "github", repo: RECORD.name, sha: "h1" } } });
  });
}, 60_000);

test("PostgreSQL: with code review on, a head that moved before intake is recorded as mailed, without a review request, and logged", async () => {
  await withDatabase(async function moved(db) {
    const { toListener, logged } = stack(db, LISTENER, { ...PULL, headSha: "h2" });
    expect(await toListener(TENANT, { ...mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h1" }), codeReview: { on: true } })).toBe(true);
    const [row] = await events(db);
    expect(row!.state.head).toBe("h1");
    expect(row!.state.payload).not.toHaveProperty("codeReviewRequest");
    expect(logged).toEqual([expect.objectContaining({ msg: "code_review_head_moved", pr: 7, headSha: "h1", hostHeadSha: "h2" })]);
  });
}, 60_000);

test("PostgreSQL: every pull request a mail names passes the gate, whatever sent it: a paused one is not recorded or mailed, and the rest are recorded as the gate leaves them", async () => {
  await withDatabase(async function gated(db) {
    const gate = createPauseGate({ readHead: async (_tenantId, _record, number) => ({ ...PULL, labels: number === 9 ? ["hold"] : [] }), log() {} });
    const { toListener, mailed } = stack(db, LISTENER, PULL, gate);
    const decided = { ...mailPayload(RECORD, POLICY, STORED, {}), pauseLabel: "hold", automatic: ["comment", "approve", "merge"], decide: [{ if: { triage: "fail" }, do: "request-changes" }] };
    // The reconciler's catch-up names its heads as items; Review again and Triage again name one; a backlog names every open one.
    expect(await toListener(TENANT, { ...decided, items: [{ prNumber: 7, headSha: "h1" }, { prNumber: 9, headSha: "h9" }] })).toBe(true);
    expect(await toListener(TENANT, { ...decided, prNumber: 9, headSha: "h9", codeReview: { on: true, rules: "any" } })).toBe(true);
    expect(await toListener(TENANT, { ...decided, kind: "backlog" })).toBe(true);
    const recorded = await events(db);
    expect(recorded.map((row) => row.state.head)).toEqual(["h1", "h1"]);
    expect(recorded.every((row) => JSON.stringify(row.state.payload["automatic"]) === JSON.stringify(["comment"]))).toBe(true);
    expect(mailed.flatMap((mail) => (mail.payload as { items: { prNumber: number }[] }).items.map((item) => item.prNumber))).toEqual([7, 7]);
  });
}, 120_000);

test("PostgreSQL: a backlog with no open pull request is taken with nothing recorded, and a failing gate read still leaves the heads recorded before it mailed", async () => {
  await withDatabase(async function partial(db) {
    const drafts = stack(db, LISTENER, PULL, passed, [{ number: 9, headSha: "h9", draft: true }]);
    expect(await drafts.toListener(TENANT, { ...mailPayload(RECORD, POLICY, STORED, {}), kind: "backlog" })).toBe(true);
    expect(drafts.mailed).toEqual([]);

    const { toListener, mailed } = stack(db, LISTENER, PULL, async function failOn9(_tenantId, _record, number, request) {
      if (number === 9) throw new Error("head read failed");
      return request;
    });
    const catchUp = mailPayload(RECORD, POLICY, STORED, { items: [{ prNumber: 7, headSha: "h1" }, { prNumber: 9, headSha: "h9" }] });
    await expect(toListener(TENANT, catchUp)).rejects.toThrow("head read failed");
    expect((await events(db)).map((row) => row.state.head)).toEqual(["h1"]);
    expect(mailed.map((mail) => (mail.payload as { items: { prNumber: number }[] }).items.map((item) => item.prNumber))).toEqual([[7]]);
  });
}, 120_000);
