// Requires PostgreSQL at TEST_DB. The listener path against a real store, with the host read and the mail recorded.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { APPROVE_DO_KIND, emptyPack, repoPolicy } from "@corbits/triage-contracts";
import type { PullRequestToReview } from "./pull-request-reader.js";
import { mailPayload, waitingPayload } from "./github/bridge.js";
import { createPauseGate } from "./github/pr-workflow.js";
import { createManagerIntake } from "./manager-intake.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_intake";
const LISTENER = "run_listener@intake.test";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
const POLICY = repoPolicy(RECORD);
const STORED = { pack: emptyPack(RECORD.name), automatic: [], source: { repo: { id: "art_pack", version: 1 } } };
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

function stack(db: Db, listener: string | undefined, pull = PULL, gate: Gate = passed) {
  const mailed: { address: string; payload: unknown }[] = [];
  const logged: Record<string, unknown>[] = [];
  const toListener = createManagerIntake({
    db,
    listener: async () => listener,
    readPull: async () => pull,
    openHeads: async () => [{ number: 7, headSha: "h1", draft: false }, { number: 9, headSha: "h9", draft: true }],
    withAppLogin: async (_tenantId, payload) => ({ ...payload, appLogin: "triage[bot]" }),
    async deliver(_tenantId, address, payload) {
      mailed.push({ address, payload });
    },
    gate,
    log: (entry) => logged.push(entry),
  });
  return { toListener, mailed, logged };
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

test("PostgreSQL: each pull request a mail names is recorded as its own event, a webhook once however often it is delivered and any other mail every time, and the listener is mailed the heads", async () => {
  await withDatabase(async function listener(db) {
    const { toListener, mailed } = stack(db, LISTENER);
    const webhook = mailPayload(RECORD, POLICY, STORED, { prNumber: 7, headSha: "h1", deliveryId: "d1" });
    expect(await toListener(TENANT, webhook)).toBe(true);
    expect(await toListener(TENANT, webhook)).toBe(true);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    expect(await toListener(TENANT, requeued(7, "h1"))).toBe(true);
    expect(await toListener(TENANT, waitingPayload(RECORD, POLICY, STORED, { number: 8, headSha: "h8" }, false))).toBe(true);
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
      "evt:github:acme/widgets#8 h8 waiting",
    ]);
    expect(recorded.map((row) => row.key)).toContain("evt:github:acme/widgets#7:d1");
    const item = recorded.find((row) => row.state.payload["kind"] === "pr" && row.state.payload["deliveryId"] === undefined)!;
    expect(item.state.payload).toMatchObject({ prNumber: 7, headSha: "h1", appLogin: "triage[bot]" });
    expect(item.state.payload).not.toHaveProperty("items");
    expect(mailed.map((mail) => mail.address)).toEqual(Array(7).fill(LISTENER));
    expect(mailed[0]!.payload).toEqual({ kind: "pr", repo: RECORD.name, tenantId: TENANT, items: [{ prNumber: 7, headSha: "h1" }] });
  });
}, 60_000);

async function claimManager(db: Db, runId: string, number: number, status: "running" | "deployed", createdAt?: Date): Promise<void> {
  await db.insert(schema.workflowDefinition).values({ id: "wfd_intake", tenantId: TENANT, name: "triage-manager-github" }).onConflictDoNothing();
  await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: "wfd_intake", tenantId: TENANT, status, ...(createdAt && { createdAt }) });
  const claim = { status: "live", claimId: `claim-${runId}`, claimedAt: new Date().toISOString(), runId, reviewers: [], history: [], starts: 1 };
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
