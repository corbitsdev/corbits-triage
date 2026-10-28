// Requires PostgreSQL at TEST_DB. The alarm against a real store, on a clock moved past the alarm age.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { recordEvent, take } from "./manager-state.js";
import { createTriageLiveness } from "./triage-liveness.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_liveness";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
const PR = { source: "github" as const, repo: RECORD.name, number: 7 };
const STALLED_AFTER_MS = 5 * 60_000;

type Db = ReturnType<typeof createDB>["db"];

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_liveness_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await migrateTriageTables(handle.db, "public");
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Liveness", slug: "liveness", domain: "liveness.test", config: { corbitsTriage: { repos: [RECORD] } } });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function stack(db: Db) {
  let at = Date.now();
  const logged: Record<string, unknown>[] = [];
  const liveness = createTriageLiveness({ db, stalledAfterMs: STALLED_AFTER_MS, now: () => new Date(at), log: (entry) => logged.push(entry) });
  return {
    liveness,
    logged,
    advance(ms: number) {
      at += ms;
    },
    alarms: () => logged.filter((entry) => entry["msg"] === "triage_stalled" || entry["msg"] === "triage_stall_cleared").map((entry) => entry["msg"]),
  };
}

test("a mail no manager takes raises the alarm once past the alarm age, and a take clears it", async () => {
  await withDatabase(async (db) => {
    const { liveness, advance, alarms } = stack(db);
    await recordEvent(db, TENANT, PR, "d1", { type: "webhook", head: "h1", payload: { kind: "pr" } });

    advance(STALLED_AFTER_MS - 60_000);
    await liveness.watch(TENANT);
    expect(alarms()).toEqual([]);

    advance(2 * 60_000);
    await liveness.watch(TENANT);
    await liveness.watch(TENANT);
    expect(alarms()).toEqual(["triage_stalled"]);

    expect((await take(db, TENANT, PR, "run_manager")).outcome).toBe("pass");
    await liveness.watch(TENANT);
    await liveness.watch(TENANT);
    expect(alarms()).toEqual(["triage_stalled", "triage_stall_cleared"]);
  });
}, 60_000);

test("a mail no manager took before the last take neither raises the alarm nor hides a later one that waits", async () => {
  await withDatabase(async (db) => {
    const { liveness, advance, alarms } = stack(db);
    await recordEvent(db, TENANT, { ...PR, number: 8 }, "old", { type: "webhook", head: "h8", payload: { kind: "pr" } });
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await db.execute(sql`update corbits_triage.manager_state set state = jsonb_set(state, '{receivedAt}', to_jsonb(${hourAgo}::text)) where key like 'evt:%:old'`);
    expect((await take(db, TENANT, { ...PR, number: 9 }, "run_other")).outcome).toBe("idle");
    await recordEvent(db, TENANT, PR, "d1", { type: "webhook", head: "h1", payload: { kind: "pr" } });

    advance(STALLED_AFTER_MS - 60_000);
    await liveness.watch(TENANT);
    expect(alarms()).toEqual([]);

    advance(2 * 60_000);
    await liveness.watch(TENANT);
    expect(alarms()).toEqual(["triage_stalled"]);
  });
}, 60_000);
