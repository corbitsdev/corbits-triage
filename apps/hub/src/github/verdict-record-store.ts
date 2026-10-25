// One row per verdict a completed pr-triage run made for a pull request head,
// copied from the live deployment's run log by the reconciler. The log holds
// only the runs since the deployment last rotated, so this table is what a
// window of stats reads, and what the portal shows of each pull request.
import { and, asc, desc, eq, getTableColumns, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { boolean, integer, jsonb, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { schema, type DB } from "@intx/db";
import type { RepoSource, VerdictDetail } from "@corbits/triage-contracts";
import { triageSchema } from "../triage-db.js";
import { jobWorkflowsFor } from "./source-workflow.js";

export type RecordedCheck = { check: string; result: string };
/** `list` is the verdict's list the Do is on; Dos recorded before verdicts were words carry their action's id instead and are not counted. */
export type RecordedDo = { list?: string; effectId: string };

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

/** A repository on its host; the same name can be on both. */
export type HostedRepo = { repo: string; source: RepoSource };

/** A pull request on its host; the same repository name and number can be on both. */
export type HostedPull = PullRef & HostedRepo;

export type HostedVerdict = VerdictRecord & { source: RepoSource };

export function evidenceOf(verdict: Pick<VerdictRecord, "detail">, check: string): string[] | undefined {
  return verdict.detail?.checks?.find((row) => row.check === check)?.evidence;
}

/** How a Do a maintainer approved ended; its effect id names it on every verdict of its head that suggests it. */
export type ApprovedDo = { repo: string; number: number; effectId: string; status: string; error?: string };

const WRITTEN = new Set(["done", "satisfied"]);

/** The verdict with each approved Do's outcome on its action; an approval that wrote it is not undone by one refused later. */
export function withApproved(detail: VerdictDetail, approved: readonly ApprovedDo[]): VerdictDetail {
  if (!detail.actions || approved.length === 0) return detail;
  const actions = detail.actions.map(function outcomeOf(action) {
    return approved.reduce(function apply(current, { effectId, status, error }) {
      if (effectId !== current.effectId || WRITTEN.has(current.status ?? "")) return current;
      const { error: _error, ...rest } = current;
      return { ...rest, status, ...(error !== undefined && { error }) };
    }, action);
  });
  return { ...detail, actions };
}

function ofPulls(pulls: readonly PullRef[]): SQL | undefined {
  return or(...pulls.map((pull) => and(eq(verdictRecord.repo, pull.repo), eq(verdictRecord.number, pull.number))));
}

/**
 * A verdict's host is its run's workflow's. A verdict whose run is gone, or from a workflow from before hosts, is GitHub's:
 * workflow runs go only with their tenant, and every workflow before hosts read GitHub.
 */
const verdictSource = sql<RepoSource>`case when ${inArray(schema.workflowDefinition.name, jobWorkflowsFor("bitbucket-datacenter"))} then 'bitbucket-datacenter' else 'github' end`;

/** The verdicts `where` picks, each with its host, to group or pick from by host. */
function hostedVerdicts(db: DB["db"], where: SQL | undefined) {
  const { workflowRun, workflowDefinition } = schema;
  return db
    .select({ ...getTableColumns(verdictRecord), source: verdictSource.as("source") })
    .from(verdictRecord)
    .leftJoin(workflowRun, and(eq(workflowRun.id, verdictRecord.runId), eq(workflowRun.tenantId, verdictRecord.tenantId)))
    .leftJoin(workflowDefinition, eq(workflowDefinition.id, workflowRun.definitionId))
    .where(where)
    .as("hosted");
}

/** The run started last read the newest head: a backlog run started before a push can make its verdict after the push's. */
function latestOf(db: DB["db"], where: SQL | undefined): Promise<HostedVerdict[]> {
  const hosted = hostedVerdicts(db, where);
  return db
    .selectDistinctOn([hosted.repo, hosted.number, hosted.source])
    .from(hosted)
    .orderBy(hosted.repo, hosted.number, hosted.source, desc(hosted.startedAt), desc(hosted.verdictAt));
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

    /** Sets each approved Do's outcome on every recorded verdict of its pull request that suggests it; a verdict not recorded yet gains it when it is. */
    async recordApproved(tenantId: string, approved: readonly ApprovedDo[]): Promise<void> {
      for (const done of approved) {
        const pull = and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, done.repo), eq(verdictRecord.number, done.number));
        const rows = await db.select({ runId: verdictRecord.runId, detail: verdictRecord.detail }).from(verdictRecord).where(pull);
        for (const { runId, detail } of rows) {
          if (!detail?.actions?.some((action) => action.effectId === done.effectId)) continue;
          await db.update(verdictRecord).set({ detail: withApproved(detail, [done]) }).where(and(pull, eq(verdictRecord.runId, runId)));
        }
      }
    },

    /** The newest verdict of each pull request on each host. */
    latest(tenantId: string, pulls: readonly PullRef[]): Promise<HostedVerdict[]> {
      if (pulls.length === 0) return Promise.resolve([]);
      return latestOf(db, and(eq(verdictRecord.tenantId, tenantId), ofPulls(pulls)));
    },

    latestSince(tenantId: string, repos: readonly string[], from: Date): Promise<HostedVerdict[]> {
      if (repos.length === 0) return Promise.resolve([]);
      return latestOf(db, and(eq(verdictRecord.tenantId, tenantId), inArray(verdictRecord.repo, [...repos]), gte(verdictRecord.verdictAt, from)));
    },

    async latestFor(tenantId: string, pull: HostedPull): Promise<HostedVerdict | undefined> {
      const latest = await latestOf(db, and(eq(verdictRecord.tenantId, tenantId), eq(verdictRecord.repo, pull.repo), eq(verdictRecord.number, pull.number)));
      return latest.find((verdict) => verdict.source === pull.source);
    },

    triggeredAt(tenantId: string, pulls: readonly PullRef[], triggers: readonly string[]): Promise<Array<HostedPull & { at: Date }>> {
      if (pulls.length === 0) return Promise.resolve([]);
      const hosted = hostedVerdicts(db, and(eq(verdictRecord.tenantId, tenantId), ofPulls(pulls), inArray(verdictRecord.trigger, [...triggers])));
      return db
        .select({ repo: hosted.repo, number: hosted.number, source: hosted.source, at: sql<Date>`max(${hosted.startedAt})`.mapWith(verdictRecord.startedAt) })
        .from(hosted)
        .groupBy(hosted.repo, hosted.number, hosted.source);
    },

    /** The repositories, each on its host, with a verdict since `from`, or ever. */
    reposSince(tenantId: string, repos: readonly string[], from?: Date): Promise<HostedRepo[]> {
      if (repos.length === 0) return Promise.resolve([]);
      const hosted = hostedVerdicts(db, and(eq(verdictRecord.tenantId, tenantId), inArray(verdictRecord.repo, [...repos]), from === undefined ? undefined : gte(verdictRecord.verdictAt, from)));
      return db.selectDistinct({ repo: hosted.repo, source: hosted.source }).from(hosted);
    },

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
