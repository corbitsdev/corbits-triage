// One row per verdict a completed pr-triage run made for a pull request head,
// copied from the live deployment's run log by the reconciler. The log holds
// only the runs since the deployment last rotated, so this table is what a
// window of stats reads.
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { DB } from "@intx/db";

export type RecordedCheck = { check: string; result: string };
export type RecordedDo = { actionId: string; effectId: string };

export const verdictRecord = pgTable("corbits_triage_verdict", {
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  repo: text("repo").notNull(),
  number: integer("number").notNull(),
  headSha: text("head_sha").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  verdictAt: timestamp("verdict_at", { withTimezone: true }).notNull(),
  settled: boolean("settled").notNull(),
  state: text("state").notNull(),
  actor: text("actor").notNull(),
  humanGated: boolean("human_gated").notNull(),
  degraded: text("degraded"),
  checks: jsonb("checks").$type<RecordedCheck[]>().notNull(),
  dos: jsonb("dos").$type<RecordedDo[]>().notNull(),
  commented: boolean("commented").notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.runId, t.repo, t.number] })]);

export type VerdictRecord = typeof verdictRecord.$inferSelect;
export type RecordedVerdict = Omit<VerdictRecord, "tenantId">;

export async function migrateVerdictRecords(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_triage_verdict (
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      run_id text NOT NULL,
      repo text NOT NULL,
      number integer NOT NULL,
      head_sha text NOT NULL,
      started_at timestamptz NOT NULL,
      verdict_at timestamptz NOT NULL,
      settled boolean NOT NULL,
      state text NOT NULL,
      actor text NOT NULL,
      human_gated boolean NOT NULL,
      degraded text,
      checks jsonb NOT NULL,
      dos jsonb NOT NULL,
      commented boolean NOT NULL,
      PRIMARY KEY (tenant_id, run_id, repo, number)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS corbits_triage_verdict_repo_idx ON corbits_triage_verdict (tenant_id, repo, verdict_at)`);
}

export function createVerdictRecordStore(db: DB["db"]) {
  return {
    /** A run's verdicts never change, so one already recorded is left as it is. */
    async record(tenantId: string, verdicts: readonly RecordedVerdict[]): Promise<void> {
      if (verdicts.length === 0) return;
      await db.insert(verdictRecord).values(verdicts.map((verdict) => ({ ...verdict, tenantId }))).onConflictDoNothing();
    },

    /** Oldest first. */
    since(tenantId: string, repo: string, from: Date): Promise<VerdictRecord[]> {
      const where = and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, repo), gte(verdictRecord.verdictAt, from));
      return db.select().from(verdictRecord).where(where).orderBy(asc(verdictRecord.verdictAt));
    },

    async earliest(tenantId: string, repo: string): Promise<Date | null> {
      const [row] = await db
        .select({ at: sql<Date | null>`min(${verdictRecord.verdictAt})`.mapWith(verdictRecord.verdictAt) })
        .from(verdictRecord)
        .where(and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, repo)));
      return row?.at ?? null;
    },
  };
}

export type VerdictRecordStore = ReturnType<typeof createVerdictRecordStore>;
