// One row per verdict a completed pr-triage run made for a pull request head,
// copied from the live deployment's run log by the reconciler. The log holds
// only the runs since the deployment last rotated, so this table is what a
// window of stats reads, and what the portal shows of each pull request.
import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { boolean, integer, jsonb, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { type } from "arktype";
import type { DB } from "@intx/db";
import { triageSchema } from "../triage-db.js";

export type RecordedCheck = { check: string; result: string };
export type RecordedDo = { actionId: string; effectId: string };

const DetailCheck = type({
  "+": "delete",
  check: "string",
  kind: "string",
  result: "string",
  "reason?": "string",
  "evidence?": "string[]",
  /** What the check found, as `CheckOutput`; the portal parses it. */
  "output?": "Record<string, unknown>",
  "gate?": "boolean",
});

const DetailAction = type({
  "+": "delete",
  id: "string",
  "branch?": "string",
  "index?": "number",
  "effectId?": "string",
  "kind?": "string",
  "reason?": "string",
  "target?": "Record<string, unknown>",
  "skipped?": "boolean",
  /** Set once the run's execute step ran the Do. */
  "status?": "string",
  "error?": "string",
});

/** What the portal shows of a verdict beyond the columns: the verdict's own fields, and the facts it was made from. */
export const VerdictDetail = type({
  "+": "delete",
  /** The head the verdict judged, which its checks' cited lines link into; it can differ from the head its run was asked about. */
  "headSha?": "string | null",
  "priority?": "string | null",
  "owner?": "string | null",
  "nextAction?": "string",
  "score?": "number | null",
  "merge?": { "+": "delete", verdict: "string", score: "number | null", threshold: "number", reasons: "string[]" },
  "reason?": "string",
  /** The verdict's reason, or the rules step's findings when it names none. */
  "evidence?": "string[]",
  "checks?": DetailCheck.array(),
  "labels?": "string[]",
  "feedback?": "string",
  "actions?": DetailAction.array(),
  "facts?": { "+": "delete", "title?": "string", "author?": "string", "draft?": "boolean", "mergeable?": "boolean | null", "checks?": "string", "reviewAnswered?": "boolean" },
});
export type VerdictDetail = typeof VerdictDetail.infer;

export const verdictRecord = triageSchema.table("verdict", {
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
  /** Null on verdicts recorded before it was. */
  detail: jsonb("detail").$type<VerdictDetail>(),
  /** The webhook event that started the run, as `event:action`; null for catch-up and portal runs, and on verdicts recorded before it was. */
  trigger: text("trigger"),
  /** How the run ended, or `running`; null on verdicts recorded before it was, which were all of completed runs. */
  runStatus: text("run_status"),
}, (t) => [primaryKey({ columns: [t.tenantId, t.runId, t.repo, t.number] })]);

export type VerdictRecord = typeof verdictRecord.$inferSelect;
export type RecordedVerdict = Omit<typeof verdictRecord.$inferInsert, "tenantId">;

export type PullRef = { repo: string; number: number };

function ofPulls(pulls: readonly PullRef[]): SQL | undefined {
  return or(...pulls.map((pull) => and(eq(verdictRecord.repo, pull.repo), eq(verdictRecord.number, pull.number))));
}

/** The newest verdict of each pull request `where` selects. */
function latestOf(db: DB["db"], where: SQL | undefined): Promise<VerdictRecord[]> {
  return db
    .selectDistinctOn([verdictRecord.repo, verdictRecord.number])
    .from(verdictRecord)
    .where(where)
    .orderBy(verdictRecord.repo, verdictRecord.number, desc(verdictRecord.verdictAt));
}

export function createVerdictRecordStore(db: DB["db"]) {
  return {
    /**
     * A verdict is recorded once its step completes; recorded again, it only gains what it was recorded without, a posted
     * reply, the Do outcomes its run went on to write, or how its run ended.
     */
    async record(tenantId: string, verdicts: readonly RecordedVerdict[]): Promise<void> {
      if (verdicts.length === 0) return;
      await db.insert(verdictRecord).values(verdicts.map((verdict) => ({ ...verdict, tenantId }))).onConflictDoUpdate({
        target: [verdictRecord.tenantId, verdictRecord.runId, verdictRecord.repo, verdictRecord.number],
        set: {
          detail: sql`coalesce(excluded.detail, ${verdictRecord.detail})`,
          trigger: sql`coalesce(${verdictRecord.trigger}, excluded.trigger)`,
          commented: sql`${verdictRecord.commented} OR excluded.commented`,
          runStatus: sql`coalesce(excluded.run_status, ${verdictRecord.runStatus})`,
        },
      });
    },

    /** The newest verdict of each of `pulls`; reads only those pull requests' rows. */
    latest(tenantId: string, pulls: readonly PullRef[]): Promise<VerdictRecord[]> {
      if (pulls.length === 0) return Promise.resolve([]);
      return latestOf(db, and(eq(verdictRecord.tenantId, tenantId), ofPulls(pulls)));
    },

    /** The newest verdict of each pull request of `repos` with one made since `from`. */
    latestSince(tenantId: string, repos: readonly string[], from: Date): Promise<VerdictRecord[]> {
      if (repos.length === 0) return Promise.resolve([]);
      return latestOf(db, and(eq(verdictRecord.tenantId, tenantId), inArray(verdictRecord.repo, [...repos]), gte(verdictRecord.verdictAt, from)));
    },

    async latestFor(tenantId: string, repo: string, number: number): Promise<VerdictRecord | undefined> {
      const [latest] = await latestOf(db, and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, repo), eq(verdictRecord.number, number)));
      return latest;
    },

    /** When the newest run started by one of `triggers` started, for each of `pulls` that has one. */
    triggeredAt(tenantId: string, pulls: readonly PullRef[], triggers: readonly string[]): Promise<Array<PullRef & { at: Date }>> {
      if (pulls.length === 0) return Promise.resolve([]);
      return db
        .select({ repo: verdictRecord.repo, number: verdictRecord.number, at: sql<Date>`max(${verdictRecord.startedAt})`.mapWith(verdictRecord.startedAt) })
        .from(verdictRecord)
        .where(and(eq(verdictRecord.tenantId, tenantId), ofPulls(pulls), inArray(verdictRecord.trigger, [...triggers])))
        .groupBy(verdictRecord.repo, verdictRecord.number);
    },

    /** Those of `repos` with a verdict made since `from`, or ever without it. */
    async reposSince(tenantId: string, repos: readonly string[], from?: Date): Promise<string[]> {
      if (repos.length === 0) return [];
      const rows = await db
        .selectDistinct({ repo: verdictRecord.repo })
        .from(verdictRecord)
        .where(and(eq(verdictRecord.tenantId, tenantId), inArray(verdictRecord.repo, [...repos]), from === undefined ? undefined : gte(verdictRecord.verdictAt, from)));
      return rows.map((row) => row.repo);
    },

    /** Whether any verdict was scored by the decision model. */
    async anyScored(tenantId: string): Promise<boolean> {
      const [row] = await db
        .select({ runId: verdictRecord.runId })
        .from(verdictRecord)
        .where(and(eq(verdictRecord.tenantId, tenantId), sql`jsonb_typeof(${verdictRecord.detail}->'score') = 'number'`))
        .limit(1);
      return row !== undefined;
    },

    /** Oldest first. */
    since(tenantId: string, repo: string, from: Date): Promise<VerdictRecord[]> {
      const where = and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, repo), gte(verdictRecord.verdictAt, from));
      return db.select().from(verdictRecord).where(where).orderBy(asc(verdictRecord.verdictAt));
    },

    /** Oldest first. */
    forPull(tenantId: string, repo: string, number: number): Promise<VerdictRecord[]> {
      const where = and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, repo), eq(verdictRecord.number, number));
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
