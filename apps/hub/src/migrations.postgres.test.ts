// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { runArtifactMigrations } from "@corbits/artifacts";
import { runCronMigrations } from "@corbits/cron/migrations";
import { createDB } from "@intx/db";
import { grantAdminsPolicyWrites } from "./artifact-grants.js";
import { migrateRepoEnabledFlag } from "./github/tenant-config.js";
import { migrationEnv } from "./env.js";
import { migrateWebhooks } from "./hooks.js";
import { assertMigrated } from "./migrations.js";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };

const ROOT = resolve(import.meta.dir, "../../..");
const CHILD_ENV = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir() };

type Config = typeof TEST_DB;
type Db = ReturnType<typeof createDB>["db"];

function ignore(): void {}

async function migrate({ database }: Config): Promise<void> {
  await Bun.$`${process.execPath} --conditions=intx-src apps/hub/src/migrate.ts`
    .cwd(ROOT)
    .env({ ...CHILD_ENV, DATABASE_URL: `postgres://postgres:postgres@localhost:5432/${database}` })
    .quiet();
}

/** What the previous `db:migrate` did; the hub's start then ran the rest. */
async function drizzleOnly(config: Config): Promise<void> {
  await Bun.$`bunx drizzle-kit migrate`
    .cwd(resolve(ROOT, "vendor/interchange/packages/db"))
    .env({ ...CHILD_ENV, ...migrationEnv(config) })
    .quiet();
}

async function snapshot(db: Db) {
  const columns = await db.execute(sql`
    SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2, 3`);
  const rows = await db.execute(sql`SELECT (SELECT count(*)::int FROM "grant") AS grants, (SELECT count(*)::int FROM tenant) AS tenants`);
  return { columns: [...columns], rows: [...rows] };
}

async function withDatabase(name: string, run: (config: Config, db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_${name}_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    handle = createDB(config);
    await run(config, handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: a fresh database migrates twice to the same state and then passes the start check", async () => {
  await withDatabase("fresh", async function migrateFresh(config, db) {
    await migrate(config);
    const [tables] = await db.execute(sql`SELECT to_regclass('corbits_triage.verdict')::text AS triage, to_regclass('artifacts.artifact')::text AS artifacts, to_regclass('cron.schedule')::text AS cron, to_regclass('webhooks.replay')::text AS webhooks`);
    expect(tables).toEqual({ triage: "corbits_triage.verdict", artifacts: "artifacts.artifact", cron: "cron.schedule", webhooks: "webhooks.replay" });
    const first = await snapshot(db);
    await migrate(config);
    expect(await snapshot(db)).toEqual(first);
    await assertMigrated(config);
  });
}, 120_000);

test("PostgreSQL: a database the old hub start migrated takes the new migrate and passes the start check", async () => {
  await withDatabase("upgrade", async function upgradeOld(config, db) {
    await drizzleOnly(config);
    await migrateWebhooks(config, ignore);
    await runArtifactMigrations(config, { schema: "public" });
    await runCronMigrations(config, { schema: "public" });
    await migrateRepoEnabledFlag(db);
    await migrateTriageTables(db, "public");
    await grantAdminsPolicyWrites(db, function now() { return new Date(); }, ignore);
    await migrate(config);
    await assertMigrated(config);
  });
}, 120_000);

test("PostgreSQL: a database without the hub's own migrations fails the start check", async () => {
  await withDatabase("hubless", async function skipHubMigrations(config) {
    await drizzleOnly(config);
    await expect(assertMigrated(config)).rejects.toThrow("Missing: 0001_corbits_triage.sql");
  });
}, 120_000);
