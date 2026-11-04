// Requires PostgreSQL at TEST_DB. The listener path against a real store, with the host read and the mail recorded.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { emptyPack, repoPolicy } from "@corbits/triage-contracts";
import type { PullRequestHead } from "./pull-request-reader.js";
import { mailPayload } from "./github/bridge.js";
import { createPauseGate } from "./github/pr-workflow.js";
import { createManagerIntake, createSupersede } from "./manager-intake.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_intake";
const LISTENER = "run_listener@intake.test";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
const POLICY = repoPolicy(RECORD);
const STORED = { pack: emptyPack(RECORD.name), automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } } };
const PULL: PullRequestHead = { headSha: "h1", open: true, draft: false, title: "Add the flag", description: "Adds it.", labels: [] };

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

function stack(db: Db, gate: Gate) {
  const mailed: { address: string; payload: unknown }[] = [];
  const toListener = createManagerIntake({
    db,
    listener: async () => LISTENER,
    routable: async () => true,
    readPull: async () => PULL,
    openHeads: async () => [{ number: 7, headSha: "h1", draft: false }, { number: 9, headSha: "h9", draft: false }],
    withAppLogin: async (_tenantId, payload) => ({ ...payload, appLogin: "triage[bot]" }),
    async deliver(_tenantId, address, payload) {
      mailed.push({ address, payload });
    },
    supersede: createSupersede({ db, async cancel() {}, log() {} }).supersede,
    gate,
    log() {},
  });
  return { toListener, mailed };
}

async function events(db: Db): Promise<{ key: string; state: { head: string; payload: Record<string, unknown> } }[]> {
  return db.execute(sql`SELECT key, state FROM corbits_triage.manager_state WHERE kind = 'event' ORDER BY key`);
}

test("PostgreSQL: every pull request a mail names passes the gate, whatever sent it: a paused one is not recorded or mailed, and the rest are recorded as the gate leaves them", async () => {
  await withDatabase(async function gated(db) {
    const gate = createPauseGate({ readHead: async (_tenantId, _record, number) => ({ ...PULL, labels: number === 9 ? ["hold"] : [] }), log() {} });
    const { toListener, mailed } = stack(db, gate);
    const decided = { ...mailPayload(RECORD, POLICY, STORED, {}), pauseLabel: "hold", automatic: ["comment", "approve", "merge"], decide: [{ if: { triage: "fail" }, do: "request-changes" }] };
    // The reconciler's catch-up names its heads as items; Review again and Triage again name one; a backlog names every open one.
    expect(await toListener(TENANT, { ...decided, items: [{ prNumber: 7, headSha: "h1" }, { prNumber: 9, headSha: "h9" }] })).toBe(true);
    expect(await toListener(TENANT, { ...decided, prNumber: 9, headSha: "h9", codeReview: { on: true, rules: "any" } })).toBe(true);
    expect(await toListener(TENANT, { ...decided, kind: "backlog" })).toBe(true);
    const recorded = await events(db);
    expect(recorded.map((row) => row.state.head)).toEqual(["h1", "h1"]);
    expect(recorded.every((row) => JSON.stringify(row.state.payload["automatic"]) === JSON.stringify(["comment", "approve", "merge"]))).toBe(true);
    expect(mailed.flatMap((mail) => (mail.payload as { items: { prNumber: number }[] }).items.map((item) => item.prNumber))).toEqual([7]);
  });
}, 120_000);
