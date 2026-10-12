// Triage's own tables live in the `corbits_triage` schema, applied from
// migrations/*.sql the way the Corbits packages apply theirs.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { pgSchema } from "drizzle-orm/pg-core";
import type { DB } from "@intx/db";

export const triageSchema = pgSchema("corbits_triage");

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
// Advisory locks are namespaced by this integer alone; arbitrary, and distinct from the Corbits packages' keys.
const LOCK_KEY = 0x0c7a_1a6e;

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `schema` is where Interchange's tables live; the `"public".` references in the SQL are rewritten to it. Every
 * statement is idempotent, and the run is one transaction behind an advisory lock so hub replicas cannot race the DDL.
 */
export async function migrateTriageTables(db: DB["db"], schema: string): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  const statements: string[] = [];
  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of raw.replace(/"public"\.(?=")/g, `${quoteIdentifier(schema)}.`).split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) statements.push(statement);
    }
  }
  await db.transaction(async function migrate(tx) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}
