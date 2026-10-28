// Requires PostgreSQL at TEST_DB. The alarm against a real store, on a clock moved past the alarm age.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { triageStopped, type PrTriageRow } from "@corbits/triage-contracts";
import { recordEvent, take } from "./manager-state.js";
import { createTriageLiveness, type StallNotice } from "./triage-liveness.js";
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
    await people(handle.db);
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

/** An owner and an admin with verified addresses, an admin without one, and a member. */
async function people(db: Db): Promise<void> {
  const roles = ["owner", "admin", "member"].map((name) => ({ id: `rol_${name}`, tenantId: TENANT, name, isSystem: true }));
  const holders = [["owner", "owner"], ["admin", "admin"], ["unverified", "admin"], ["member", "member"]] as const;
  await db.insert(schema.role).values(roles);
  await db.insert(schema.user).values(holders.map(([who]) => ({ id: `usr_${who}`, email: `${who}@liveness.test`, name: who, emailVerified: who !== "unverified" })));
  await db.insert(schema.principal).values(holders.map(([who]) => ({ id: `prn_${who}`, tenantId: TENANT, kind: "user" as const, refId: `usr_${who}`, status: "active" as const })));
  await db.insert(schema.principalRole).values(holders.map(([who, role]) => ({ principalId: `prn_${who}`, roleId: `rol_${role}` })));
}

const TENANT_ROW = { id: TENANT, config: { corbitsTriage: { repos: [RECORD] } } };

function stack(db: Db, rows: PrTriageRow[] = [], mails = true) {
  let at = Date.now();
  const logged: Record<string, unknown>[] = [];
  const mailed: StallNotice[] = [];
  const store = { load: async () => ({ rows, version: null }) };
  async function mail(notice: StallNotice) {
    mailed.push(notice);
  }
  const liveness = createTriageLiveness({ db, store, stalledAfterMs: STALLED_AFTER_MS, mail: mails ? mail : undefined, now: () => new Date(at), log: (entry) => logged.push(entry) });
  return {
    liveness,
    logged,
    mailed,
    advance(ms: number) {
      at += ms;
    },
    alarms: () => logged.filter((entry) => entry["msg"] === "triage_stalled" || entry["msg"] === "triage_stall_cleared").map((entry) => entry["msg"]),
  };
}

test("a mail no manager takes raises the alarm once past the alarm age, and a take clears it", async () => {
  await withDatabase(async (db) => {
    const { liveness, advance, alarms, mailed } = stack(db);
    await recordEvent(db, TENANT, PR, "d1", { type: "webhook", head: "h1", payload: { kind: "pr" } });

    advance(STALLED_AFTER_MS - 60_000);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual([]);

    advance(2 * 60_000);
    await liveness.watch(TENANT_ROW);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled"]);

    expect((await take(db, TENANT, PR, "run_manager")).outcome).toBe("pass");
    await liveness.watch(TENANT_ROW);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled", "triage_stall_cleared"]);
    const to = ["admin@liveness.test", "owner@liveness.test"];
    expect(mailed.map(({ to, workspace, cleared }) => ({ to, workspace, cleared }))).toEqual([{ to, workspace: "Liveness", cleared: false }, { to, workspace: "Liveness", cleared: true }]);
    expect(mailed[0]?.since).toBe(mailed[1]?.since);
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
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual([]);

    advance(2 * 60_000);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled"]);
  });
}, 60_000);

test("a head whose mail found no listener raises the alarm, and a take clears it", async () => {
  await withDatabase(async (db) => {
    const queuedAt = new Date().toISOString();
    const row: PrTriageRow = { number: 7, headSha: "h1", status: "failed", error: triageStopped("github"), attempts: 0, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt };
    const { liveness, advance, alarms } = stack(db, [row]);
    await new Promise((done) => setTimeout(done, 5));

    advance(STALLED_AFTER_MS - 60_000);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual([]);

    advance(2 * 60_000);
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled"]);

    expect((await take(db, TENANT, PR, "run_manager")).outcome).toBe("idle");
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled", "triage_stall_cleared"]);
  });
}, 60_000);

test("a hub that sends no email says so once and still raises and clears the alarm", async () => {
  await withDatabase(async (db) => {
    const { liveness, advance, alarms, logged } = stack(db, [], false);
    await recordEvent(db, TENANT, PR, "d1", { type: "webhook", head: "h1", payload: { kind: "pr" } });
    advance(STALLED_AFTER_MS + 60_000);
    await liveness.watch(TENANT_ROW);
    expect((await take(db, TENANT, PR, "run_manager")).outcome).toBe("pass");
    await liveness.watch(TENANT_ROW);
    expect(alarms()).toEqual(["triage_stalled", "triage_stall_cleared"]);
    expect(logged.filter((entry) => entry["msg"] === "triage_stall_not_emailed").map((entry) => entry["reason"])).toEqual(["SMTP_URL is not set"]);
  });
}, 60_000);
