import { resolve } from "node:path";
import { type } from "arktype";
import { sql } from "drizzle-orm";
import { createDB } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import { runCronMigrations } from "@corbits/cron/migrations";
import { grantAdminsPolicyWrites } from "./artifact-grants.js";
import type { DatabaseConfig } from "./env.js";
import { migrateRepoEnabledFlag } from "./github/tenant-config.js";
import { migrateWebhooks } from "./hooks.js";
import { migrateTriageTables, triageMigrations, triageSchema } from "./triage-db.js";

const INTERCHANGE_JOURNAL = resolve(import.meta.dir, "../../../vendor/interchange/packages/db/migrations/meta/_journal.json");
const NOT_MIGRATED = "Database is not migrated: run `bun run db:migrate` before starting the hub.";

const Journal = type({ entries: "unknown[]" });

/** Everything the hub's database needs beyond Interchange's drizzle migrations. */
export async function migrateDatabase(database: DatabaseConfig, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const { schema = "public", statementTimeoutMs: _, ...connection } = database;
  await migrateWebhooks(database, log);
  await runArtifactMigrations(connection, { schema });
  log({ level: "info", msg: "artifact_migrations_applied" });
  await runCronMigrations(connection, { schema });
  log({ level: "info", msg: "cron_migrations_applied" });
  const { db, close } = createDB(database);
  try {
    await migrateTriageTables(db, schema);
    await migrateRepoEnabledFlag(db);
    await grantAdminsPolicyWrites(db, function now() { return new Date(); }, log);
  } finally {
    await close();
  }
}

export async function assertMigrated(database: DatabaseConfig): Promise<void> {
  const { entries } = Journal.assert(await Bun.file(INTERCHANGE_JOURNAL).json());
  const { db, close } = createDB(database);
  try {
    const [{ table }] = await db.execute<{ table: string | null }>(sql`select to_regclass('drizzle.__drizzle_migrations')::text as table`);
    if (table === null) throw new Error(NOT_MIGRATED);
    const [{ applied }] = await db.execute<{ applied: number }>(sql`select count(*)::int as applied from drizzle.__drizzle_migrations`);
    if (applied < entries.length) throw new Error(NOT_MIGRATED);
    const [{ recorded }] = await db.execute<{ recorded: string | null }>(sql`select obj_description(to_regnamespace(${triageSchema.schemaName}), 'pg_namespace') as recorded`);
    const missing = (await triageMigrations()).filter((file) => recorded === null || file > recorded);
    if (missing.length > 0) throw new Error(`${NOT_MIGRATED} Missing: ${missing.join(", ")}.`);
  } finally {
    await close();
  }
}
