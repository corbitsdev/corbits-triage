// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { migrateTriageTables } from "./triage-db.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_move";

type Db = ReturnType<typeof createDB>["db"];

// The tables as the previous build created them in the host schema.
const PUBLIC_TABLES = [
  `CREATE TABLE corbits_triage_verdict (
    tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, run_id text NOT NULL, repo text NOT NULL, number integer NOT NULL,
    head_sha text NOT NULL, started_at timestamptz NOT NULL, verdict_at timestamptz NOT NULL, settled boolean NOT NULL, state text NOT NULL,
    actor text NOT NULL, human_gated boolean NOT NULL, degraded text, checks jsonb NOT NULL, dos jsonb NOT NULL, commented boolean NOT NULL,
    PRIMARY KEY (tenant_id, run_id, repo, number))`,
  "ALTER TABLE corbits_triage_verdict ADD COLUMN detail jsonb",
  "ALTER TABLE corbits_triage_verdict ADD COLUMN trigger text",
  "ALTER TABLE corbits_triage_verdict ADD COLUMN run_status text",
  "CREATE INDEX corbits_triage_verdict_repo_idx ON corbits_triage_verdict (tenant_id, repo, verdict_at)",
  "CREATE INDEX corbits_triage_verdict_pull_idx ON corbits_triage_verdict (tenant_id, repo, number, verdict_at)",
  `CREATE TABLE corbits_triage_do_run (
    tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, effect_id text NOT NULL, run_id text NOT NULL, repo text NOT NULL,
    number integer NOT NULL, head_sha text NOT NULL, action_id text NOT NULL, branch text NOT NULL, do_index integer NOT NULL, kind text NOT NULL,
    source text NOT NULL, principal_id text REFERENCES principal(id) ON DELETE SET NULL,
    status text NOT NULL CHECK (status IN ('running', 'done', 'satisfied', 'failed')), result jsonb, error text, attempts integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, effect_id))`,
  "CREATE INDEX corbits_triage_do_run_pr_idx ON corbits_triage_do_run (tenant_id, repo, number, created_at DESC)",
  `CREATE TABLE corbits_triage_invitation (
    id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE, email text NOT NULL,
    role_id text NOT NULL REFERENCES role(id) ON DELETE CASCADE, invited_by text REFERENCES principal(id) ON DELETE SET NULL,
    token_hash text NOT NULL UNIQUE, token text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
    revoked_at timestamptz, accepted_at timestamptz, accepted_by text REFERENCES "user"(id) ON DELETE SET NULL, emailed_at timestamptz)`,
  "CREATE INDEX corbits_triage_invitation_email_idx ON corbits_triage_invitation (email, tenant_id)",
  "CREATE UNIQUE INDEX corbits_triage_invitation_open_idx ON corbits_triage_invitation (tenant_id, lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL",
  `INSERT INTO corbits_triage_verdict VALUES ('${TENANT}', 'run_1', 'acme/widgets', 1, 'abc', now(), now(), true, 'ready', 'author', false, null, '[]', '[]', false, '{}', null, 'completed')`,
  `INSERT INTO corbits_triage_do_run (tenant_id, effect_id, run_id, repo, number, head_sha, action_id, branch, do_index, kind, source, status, attempts)
    VALUES ('${TENANT}', 'e1', 'run_1', 'acme/widgets', 1, 'abc', 'a', 'always', 0, 'labels', 'workflow', 'done', 1)`,
  `INSERT INTO corbits_triage_invitation (id, tenant_id, email, role_id, token_hash, token, expires_at)
    VALUES ('inv_1', '${TENANT}', 'ann@move.test', 'rol_move', 'hash', 'token', now() + interval '1 day')`,
];

/** Columns, constraints and indexes of the `corbits_triage` schema, and what is left of the old tables. */
async function shape(db: Db) {
  const columns = await db.execute(sql`
    SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
    WHERE table_schema = 'corbits_triage' ORDER BY table_name, ordinal_position`);
  const constraints = await db.execute(sql`
    SELECT conrelid::regclass::text AS table, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE connamespace = 'corbits_triage'::regnamespace ORDER BY conname`);
  const indexes = await db.execute(sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'corbits_triage' ORDER BY indexname`);
  const leftover = await db.execute(sql`SELECT tablename FROM pg_tables WHERE tablename LIKE 'corbits\_triage\_%'`);
  return { columns: [...columns], constraints: [...constraints], indexes: [...indexes], leftover: [...leftover] };
}

async function withDatabase(name: string, run: (db: Db) => Promise<void>): Promise<void> {
  const database = `corbits_${name}_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: the old host-schema tables move into corbits_triage with their rows, and match a fresh install", async () => {
  let moved: Awaited<ReturnType<typeof shape>> | undefined;
  let fresh: Awaited<ReturnType<typeof shape>> | undefined;
  await withDatabase("move", async function moveOld(db) {
    await db.insert(schema.tenant).values({ id: TENANT, name: "Move", slug: "move", domain: "move.test" });
    await db.insert(schema.role).values({ id: "rol_move", tenantId: TENANT, name: "member" });
    for (const statement of PUBLIC_TABLES) await db.execute(sql.raw(statement));
    await migrateTriageTables(db, "public");
    await migrateTriageTables(db, "public");
    expect([...await db.execute(sql`SELECT run_id, run_status FROM corbits_triage.verdict`)]).toEqual([{ run_id: "run_1", run_status: "completed" }]);
    expect([...await db.execute(sql`SELECT effect_id, status FROM corbits_triage.do_run`)]).toEqual([{ effect_id: "e1", status: "done" }]);
    expect([...await db.execute(sql`SELECT id, email FROM corbits_triage.invitation`)]).toEqual([{ id: "inv_1", email: "ann@move.test" }]);
    moved = await shape(db);
  });
  await withDatabase("fresh", async function installFresh(db) {
    await migrateTriageTables(db, "public");
    await migrateTriageTables(db, "public");
    fresh = await shape(db);
  });
  expect(moved!.leftover).toEqual([]);
  expect(fresh!.columns).toHaveLength(49);
  expect(moved).toEqual(fresh);
}, 120_000);
