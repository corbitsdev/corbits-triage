// Requires PostgreSQL at TEST_DB. The alarm against a real store, on a clock moved past the alarm age.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { triageStopped, type PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, planTenant } from "./github/reconcile-plan.js";
import { failHead } from "./github/triage-queue.js";
import { recordEvent, take, type PullRequestRef } from "./manager-state.js";
import { createTakeLedger, createTriageLiveness, type StallNotice } from "./triage-liveness.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_liveness";
const RECORD = { name: "acme/widgets", connected: true, enabled: true };
const PR: PullRequestRef = { source: "github", repo: RECORD.name, number: 7 };
const BITBUCKET: PullRequestRef = { source: "bitbucket-datacenter", repo: "PROJ/widgets", number: 3 };
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

/** The repository's triage state in memory, as the reconciler and the coalescer read and write it. */
function memoryStore(initial: PrTriageRow[]) {
  let rows = initial;
  return {
    rows: () => rows,
    async load() {
      return { rows, version: null };
    },
    async save(_tenantId: string, _repo: string, next: PrTriageRow[]) {
      rows = next;
      return null;
    },
  };
}

function stack(db: Db, store = memoryStore([]), mails = true) {
  let at = Date.now();
  const logged: Record<string, unknown>[] = [];
  const mailed: StallNotice[] = [];
  const takes = createTakeLedger();
  async function mail(notice: StallNotice) {
    mailed.push(notice);
  }
  const liveness = createTriageLiveness({ db, store, takes, stalledAfterMs: STALLED_AFTER_MS, mail: mails ? mail : undefined, now: () => new Date(at), log: (entry) => logged.push(entry) });
  return {
    takes,
    logged,
    mailed,
    now: () => new Date(at),
    advance(ms: number) {
      at += ms;
    },
    check: () => liveness.check(async () => [TENANT_ROW]),
    stalled: () => liveness.stalled(TENANT),
    alarms: () => logged.filter((entry) => entry["msg"] === "triage_stalled" || entry["msg"] === "triage_stall_cleared").map((entry) => `${String(entry["msg"])} ${String(entry["source"])}`),
    /** A manager of the host takes a pull request, as the take route notes it. */
    async took(pr: PullRequestRef) {
      expect((await take(db, TENANT, pr, `run_${pr.source}_${pr.number}`)).outcome).not.toBe("refused");
      takes.note(TENANT, pr.source, new Date().toISOString());
    },
  };
}

function mailOf(pr: PullRequestRef, id: string, db: Db) {
  return recordEvent(db, TENANT, pr, id, { type: "webhook", head: "h1", payload: { kind: "pr" } });
}

test("a mail no manager takes raises the alarm once past the alarm age, and a take clears it", async () => {
  await withDatabase(async (db) => {
    const hub = stack(db);
    await mailOf(PR, "d1", db);

    hub.advance(STALLED_AFTER_MS - 60_000);
    await hub.check();
    expect(hub.alarms()).toEqual([]);

    hub.advance(2 * 60_000);
    await hub.check();
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github"]);
    expect(hub.stalled()).toMatchObject([{ source: "github" }]);

    await hub.took(PR);
    await hub.check();
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github", "triage_stall_cleared github"]);
    expect(hub.stalled()).toEqual([]);
    const to = ["admin@liveness.test", "owner@liveness.test"];
    expect(hub.mailed.map(({ to, workspace, source, cleared }) => ({ to, workspace, source, cleared }))).toEqual([
      { to, workspace: "Liveness", source: "github", cleared: false },
      { to, workspace: "Liveness", source: "github", cleared: true },
    ]);
  });
}, 60_000);

test("a mail no manager took before the last take, read back as the hub starts, neither raises the alarm nor hides a later one", async () => {
  await withDatabase(async (db) => {
    const hub = stack(db);
    await mailOf({ ...PR, number: 8 }, "old", db);
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
    await db.execute(sql`update corbits_triage.manager_state set state = jsonb_set(state, '{receivedAt}', to_jsonb(${hourAgo}::text)) where key like 'evt:%:old'`);
    expect((await take(db, TENANT, { ...PR, number: 9 }, "run_other")).outcome).toBe("idle");
    await hub.takes.seed(db);
    await mailOf(PR, "d1", db);

    hub.advance(STALLED_AFTER_MS - 60_000);
    await hub.check();
    expect(hub.alarms()).toEqual([]);

    hub.advance(2 * 60_000);
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github"]);
  });
}, 60_000);

test("a head whose mail finds no listener stays stalled while the reconciler retries it, until a manager takes", async () => {
  await withDatabase(async (db) => {
    const queuedAt = new Date().toISOString();
    const store = memoryStore([{ number: 7, headSha: "h1", status: "queued", attempts: 1, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt }]);
    const hub = stack(db, store);
    const head = { tenantId: TENANT, repo: RECORD.name, number: 7, headSha: "h1" };
    await failHead(store, head, triageStopped("github"), new Date());

    hub.advance(STALLED_AFTER_MS + 60_000);
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github"]);

    for (let retry = 0; retry < 3; retry++) {
      hub.advance(60 * 60_000);
      const open = [{ number: 7, headSha: "h1", updatedAt: queuedAt, draft: false }];
      const plan = planTenant({ repos: [{ name: RECORD.name, prs: open, rows: store.rows() }], runs: new Map(), now: hub.now(), policy: DEFAULT_RECONCILE_POLICY }).get(RECORD.name)!;
      expect(plan.enqueue.map((queued) => queued.number)).toEqual([7]);
      await store.save(TENANT, RECORD.name, plan.rows);
      await failHead(store, head, triageStopped("github"), hub.now());
      await hub.check();
    }
    expect(store.rows()).toMatchObject([{ status: "failed", undeliveredSince: queuedAt }]);
    expect(hub.alarms()).toEqual(["triage_stalled github"]);
    expect(hub.mailed.length).toBe(1);

    await hub.took(PR);
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github", "triage_stall_cleared github"]);
  });
}, 60_000);

test("a host whose managers stop taking raises its own alarm while the other host's keep taking, and a failing workspace stops no other", async () => {
  await withDatabase(async (db) => {
    const hub = stack(db);
    await mailOf(PR, "d1", db);
    const broken = { id: "tnt_gone", config: { corbitsTriage: { repos: [RECORD] } } };

    for (let pass = 0; pass < 4; pass++) {
      hub.advance(5 * 60_000);
      await hub.took(BITBUCKET);
      await hub.check();
    }
    expect(hub.alarms()).toEqual(["triage_stalled github"]);
    expect(hub.stalled().map((host) => host.source)).toEqual(["github"]);

    hub.logged.length = 0;
    const failing = createTriageLiveness({
      db,
      store: { load: async (tenantId) => { if (tenantId === broken.id) throw new Error("store down"); return { rows: [], version: null }; } },
      takes: hub.takes,
      stalledAfterMs: STALLED_AFTER_MS,
      mail: undefined,
      now: hub.now,
      log: (entry) => hub.logged.push(entry),
    });
    await failing.check(async () => [broken, TENANT_ROW]);
    expect(hub.logged.filter((entry) => entry["msg"] !== "triage_stall_not_emailed").map((entry) => [entry["msg"], entry["tenantId"]])).toEqual([["triage_liveness_failed", broken.id], ["triage_stalled", TENANT]]);
  });
}, 60_000);

test("a hub that sends no email says so once and still raises and clears the alarm", async () => {
  await withDatabase(async (db) => {
    const hub = stack(db, memoryStore([]), false);
    await mailOf(PR, "d1", db);
    hub.advance(STALLED_AFTER_MS + 60_000);
    await hub.check();
    await hub.took(PR);
    await hub.check();
    expect(hub.alarms()).toEqual(["triage_stalled github", "triage_stall_cleared github"]);
    expect(hub.logged.filter((entry) => entry["msg"] === "triage_stall_not_emailed").map((entry) => entry["reason"])).toEqual(["SMTP_URL is not set"]);
  });
}, 60_000);
