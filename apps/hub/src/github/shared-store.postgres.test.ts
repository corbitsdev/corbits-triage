// Requires PostgreSQL at TEST_DB. Two writers on one repository's triage
// state, through one store or two, must never overwrite each other unseen.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { createTriageStateStore, TriageStateConflictError, type TriageStateStore } from "./triage-state-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const REPO = "acme/widgets";
const TENANT = "tnt_state";

function row(number: number, status: PrTriageRow["status"]): PrTriageRow {
  return { number, headSha: "abc", status, attempts: 0, firstSeenAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z" };
}

async function withStores(body: (make: () => TriageStateStore) => Promise<void>): Promise<void> {
  const database = `corbits_shared_state_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: TENANT, name: "State", slug: "state", domain: "state.test" });
    await db.insert(schema.principal).values({ id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" });
    await body(() => createTriageStateStore({ db, writerFor: async () => "prn_github", log: () => {} }));
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

async function refused(write: () => Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await write();
  } catch (cause) {
    err = cause;
  }
  expect(err).toBeInstanceOf(TriageStateConflictError);
}

test("PostgreSQL: one shared store, route loads, reconciler loads, route saves; the reconciler's save is refused", async () => {
  await withStores(async (make) => {
    const shared = make();
    await shared.save(TENANT, REPO, [row(1, "triaged")], null);
    const route = await shared.load(TENANT, REPO);
    const reconciler = await shared.load(TENANT, REPO);
    await shared.save(TENANT, REPO, route.rows.map((r) => ({ ...r, status: "queued" as const })), route.version);
    await refused(() => shared.save(TENANT, REPO, reconciler.rows.map((r) => ({ ...r, status: "failed" as const })), reconciler.version));
    expect((await make().load(TENANT, REPO)).rows.map((r) => r.status)).toEqual(["queued"]);
  });
}, 120_000);

test("PostgreSQL: one shared store, reconciler loads first, route loads and saves; the reconciler's save is refused", async () => {
  await withStores(async (make) => {
    const shared = make();
    await shared.save(TENANT, REPO, [row(1, "failed")], null);
    const reconciler = await shared.load(TENANT, REPO);
    const route = await shared.load(TENANT, REPO);
    await shared.save(TENANT, REPO, route.rows.map((r) => ({ ...r, status: "queued" as const })), route.version);
    await refused(() => shared.save(TENANT, REPO, [...reconciler.rows, row(2, "new")], reconciler.version));
    expect((await make().load(TENANT, REPO)).rows.map((r) => `${r.number}:${r.status}`)).toEqual(["1:queued"]);
  });
}, 120_000);

test("PostgreSQL: two stores, as two processes, refuse the second writer", async () => {
  await withStores(async (make) => {
    const a = make();
    const b = make();
    await a.save(TENANT, REPO, [row(1, "triaged")], null);
    const ra = await a.load(TENANT, REPO);
    const rb = await b.load(TENANT, REPO);
    await a.save(TENANT, REPO, ra.rows, ra.version);
    await refused(() => b.save(TENANT, REPO, rb.rows, rb.version));
  });
}, 120_000);

test("PostgreSQL: the first save when nothing is stored is refused for the second writer", async () => {
  await withStores(async (make) => {
    const a = make();
    const b = make();
    const first = await a.load(TENANT, REPO);
    const second = await b.load(TENANT, REPO);
    expect(first).toEqual({ rows: [], version: null });
    expect(second).toEqual({ rows: [], version: null });
    await a.save(TENANT, REPO, [row(1, "queued")], first.version);
    await refused(() => b.save(TENANT, REPO, [row(2, "new")], second.version));
    expect((await make().load(TENANT, REPO)).rows.map((r) => `${r.number}:${r.status}`)).toEqual(["1:queued"]);
  });
}, 120_000);
