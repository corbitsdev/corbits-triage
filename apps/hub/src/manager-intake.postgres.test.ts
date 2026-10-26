// Requires PostgreSQL at TEST_DB. The listener path against a real store, with the host read and the mail recorded.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import type { PullRequestToReview } from "./code-review-feed.js";
import type { TriageJob } from "./github/coordinator.js";
import { createManagerIntake } from "./manager-intake.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_intake";
const LISTENER = "run_listener@intake.test";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
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
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Intake", slug: "intake", domain: "intake.test" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function job(payload: Record<string, unknown>): TriageJob {
  return { tenantId: TENANT, workflow: "pr-triage-github", repo: RECORD.name, number: 7, headSha: "h1", source: "event", payload: { kind: "pr", repo: RECORD.name, prNumber: 7, headSha: "h1", ...payload }, record: RECORD };
}

function stack(db: Db, listener: string | undefined) {
  const mailed: { address: string; payload: unknown }[] = [];
  const toListener = createManagerIntake({
    db,
    listener: async () => listener,
    readPull: async () => PULL,
    async deliver(_tenantId, address, payload) {
      mailed.push({ address, payload });
    },
  });
  return { toListener, mailed };
}

async function events(db: Db): Promise<number> {
  const [row] = await db.execute<{ events: number }>(sql`SELECT count(*)::int AS events FROM corbits_triage.manager_state WHERE kind = 'event'`);
  return row.events;
}

test("PostgreSQL: a workspace without a listener records nothing and mails nothing, so its pull requests route as today", async () => {
  await withDatabase(async function noListener(db) {
    const { toListener, mailed } = stack(db, undefined);
    expect(await toListener(job({ codeReview: { on: true } }))).toBe(false);
    expect({ events: await events(db), mailed }).toEqual({ events: 0, mailed: [] });
  });
}, 60_000);

test("PostgreSQL: with a listener the mail is recorded as a webhook event and sent to it with the tenant and, with code review on, the head's review request", async () => {
  await withDatabase(async function listener(db) {
    const { toListener, mailed } = stack(db, LISTENER);
    expect(await toListener(job({}))).toBe(true);
    expect(await toListener(job({ codeReview: { on: true } }))).toBe(true);
    expect(await toListener({ ...job({}), payload: { kind: "waiting" } })).toBe(false);
    expect(await events(db)).toBe(2);
    expect(mailed.map((mail) => mail.address)).toEqual([LISTENER, LISTENER]);
    expect(mailed[0]!.payload).toEqual({ kind: "pr", repo: RECORD.name, prNumber: 7, headSha: "h1", tenantId: TENANT });
    expect(mailed[1]!.payload).toMatchObject({ tenantId: TENANT, codeReviewRequest: { kind: "code-review", number: 7, title: PULL.title, checkout: { source: "github", repo: RECORD.name, sha: "h1" } } });
  });
}, 60_000);
