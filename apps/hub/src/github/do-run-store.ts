// One row per pack Do effect, holding its latest state; the claim makes two
// requests for the same effect write to GitHub at most once.
import { and, desc, eq, lt, or, sql, type SQL } from "drizzle-orm";
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import type { DB } from "@intx/db";
import type { ActionKind } from "@corbits/triage-contracts";
import type { Branch } from "../../../../packages/triage-workflows/src/logic/actions.js";
import type { DoOutcome } from "../../../../packages/triage-workflows/src/logic/execute-do.js";

/** A running claim older than this is taken to have died and may be claimed again. */
const LEASE = sql`interval '2 minutes'`;
const LIST_LIMIT = 200;

export const doRun = pgTable("corbits_triage_do_run", {
  tenantId: text("tenant_id").notNull(),
  effectId: text("effect_id").notNull(),
  runId: text("run_id").notNull(),
  repo: text("repo").notNull(),
  number: integer("number").notNull(),
  headSha: text("head_sha").notNull(),
  actionId: text("action_id").notNull(),
  branch: text("branch").$type<Branch>().notNull(),
  index: integer("do_index").notNull(),
  kind: text("kind").$type<ActionKind>().notNull(),
  source: text("source").$type<"portal" | "workflow">().notNull(),
  principalId: text("principal_id"),
  status: text("status").$type<"running" | DoOutcome["status"] | "failed">().notNull(),
  result: jsonb("result"),
  error: text("error"),
  attempts: integer("attempts").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.effectId] })]);

export type DoRun = typeof doRun.$inferSelect;
export type DoClaim = Omit<DoRun, "status" | "result" | "error" | "attempts" | "createdAt" | "updatedAt">;

export async function migrateDoRuns(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_triage_do_run (
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      effect_id text NOT NULL,
      run_id text NOT NULL,
      repo text NOT NULL,
      number integer NOT NULL,
      head_sha text NOT NULL,
      action_id text NOT NULL,
      branch text NOT NULL,
      do_index integer NOT NULL,
      kind text NOT NULL,
      source text NOT NULL,
      principal_id text REFERENCES principal(id) ON DELETE SET NULL,
      status text NOT NULL CHECK (status IN ('running', 'done', 'satisfied', 'failed')),
      result jsonb,
      error text,
      attempts integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, effect_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS corbits_triage_do_run_pr_idx ON corbits_triage_do_run (tenant_id, repo, number, created_at DESC)`);
}

export type DoRunFilter = { repo: string; number?: number; runId?: string };

export function createDoRunStore(db: DB["db"]) {
  function key(tenantId: string, effectId: string): SQL {
    return and(eq(doRun.tenantId, tenantId), eq(doRun.effectId, effectId))!;
  }

  /** `attempts` fences the row: only the claim that set it may settle it. */
  function owned(run: DoRun): SQL {
    return and(key(run.tenantId, run.effectId), eq(doRun.status, "running"), eq(doRun.attempts, run.attempts))!;
  }

  return {
    /** The claimed row, or undefined when another request settled it or holds a live claim. */
    async claim(claim: DoClaim): Promise<DoRun | undefined> {
      const [row] = await db
        .insert(doRun)
        .values({ ...claim, status: "running", attempts: 1 })
        .onConflictDoUpdate({
          target: [doRun.tenantId, doRun.effectId],
          set: {
            status: "running",
            attempts: sql`${doRun.attempts} + 1`,
            runId: claim.runId,
            source: claim.source,
            principalId: claim.principalId,
            error: null,
            updatedAt: sql`now()`,
          },
          setWhere: or(eq(doRun.status, "failed"), and(eq(doRun.status, "running"), lt(doRun.updatedAt, sql`now() - ${LEASE}`))),
        })
        .returning();
      return row;
    },

    async read(tenantId: string, effectId: string): Promise<DoRun | undefined> {
      const [row] = await db.select().from(doRun).where(key(tenantId, effectId));
      return row;
    },

    /** Undefined when the claim was lost to a later one after its lease expired. */
    async settle(run: DoRun, outcome: DoOutcome): Promise<DoRun | undefined> {
      const [row] = await db.update(doRun).set({ ...outcome, updatedAt: sql`now()` }).where(owned(run)).returning();
      return row;
    },

    async fail(run: DoRun, error: string): Promise<DoRun | undefined> {
      const [row] = await db.update(doRun).set({ status: "failed", error, updatedAt: sql`now()` }).where(owned(run)).returning();
      return row;
    },

    /** Newest first. */
    list(tenantId: string, filter: DoRunFilter): Promise<DoRun[]> {
      const where = and(
        eq(doRun.tenantId, tenantId),
        eq(doRun.repo, filter.repo),
        filter.number === undefined ? undefined : eq(doRun.number, filter.number),
        filter.runId === undefined ? undefined : eq(doRun.runId, filter.runId),
      );
      return db.select().from(doRun).where(where).orderBy(desc(doRun.createdAt)).limit(LIST_LIMIT);
    },
  };
}

export type DoRunStore = ReturnType<typeof createDoRunStore>;
