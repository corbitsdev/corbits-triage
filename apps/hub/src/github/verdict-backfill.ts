// Fills in verdicts recorded before the table kept what the portal shows, and
// records those no live log holds any more, from the run logs of every ended
// pr-triage deployment; live ones are the recording loop's. Each deployment is
// read once: its anchor is kept once done, so a restart reads only deployments
// not done yet, and one whose run repository cannot be found is tried again.
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunReader } from "@intx/hub-sessions";
import type { TenantVersions } from "./tenant-observer.js";
import { recordedVerdicts } from "./triage-runs.js";
import type { RecordedVerdict, VerdictRecordStore } from "./verdict-record-store.js";

const backfilled = pgTable("corbits_triage_verdict_backfill", {
  tenantId: text("tenant_id").notNull(),
  anchorRunId: text("anchor_run_id").notNull(),
  doneAt: timestamp("done_at", { withTimezone: true }).notNull(),
}, (t) => [primaryKey({ columns: [t.tenantId, t.anchorRunId] })]);

/** Verdicts recorded in one insert at most. */
const BATCH = 200;

export async function migrateVerdictBackfill(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_triage_verdict_backfill (
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      anchor_run_id text NOT NULL,
      done_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, anchor_run_id)
    )
  `);
}

export type VerdictBackfillDeps = {
  db: DB["db"];
  runReader: WorkflowRunReader;
  verdicts: Pick<VerdictRecordStore, "record">;
  versions: TenantVersions;
  /** The pr-triage workflow's definition name. */
  workflow: string;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

export function createVerdictBackfill(deps: VerdictBackfillDeps) {
  /** Every ended deployment of the workflow not done yet, oldest first. */
  function pending() {
    const { workflowRun, workflowDefinition, tenant, liveWorkflowRunStatuses } = schema;
    return deps.db
      .select({ tenantId: workflowRun.tenantId, anchorRunId: workflowRun.id, domain: tenant.domain })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .innerJoin(tenant, eq(workflowRun.tenantId, tenant.id))
      .leftJoin(backfilled, and(eq(backfilled.tenantId, workflowRun.tenantId), eq(backfilled.anchorRunId, workflowRun.id)))
      .where(and(
        eq(workflowDefinition.name, deps.workflow),
        eq(workflowRun.id, workflowRun.anchorRunId),
        notInArray(workflowRun.status, [...liveWorkflowRunStatuses]),
        isNull(backfilled.anchorRunId),
      ))
      .orderBy(asc(workflowRun.createdAt));
  }

  async function deployment(tenantId: string, anchorRunId: string, domain: string): Promise<void> {
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, domain));
    if (!(await deps.runReader.hasRepository(repoId))) {
      deps.log({ level: "warn", msg: "triage_verdicts_backfill_skipped", tenantId, deployment: anchorRunId, reason: "run_repository_missing" });
      return;
    }
    const runIds = (await deps.runReader.listRunIds(repoId, WORKFLOW_RUN_REF)).filter((runId) => runId !== anchorRunId);
    const verdicts: RecordedVerdict[] = [];
    for (const runId of runIds) verdicts.push(...recordedVerdicts(runId, await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId)));
    for (let from = 0; from < verdicts.length; from += BATCH) await deps.verdicts.record(tenantId, verdicts.slice(from, from + BATCH));
    await deps.db.insert(backfilled).values({ tenantId, anchorRunId, doneAt: deps.now() }).onConflictDoNothing();
    if (verdicts.length > 0) deps.versions.bump(tenantId);
    deps.log({ level: "info", msg: "triage_verdicts_backfilled", tenantId, deployment: anchorRunId, runs: runIds.length, verdicts: verdicts.length });
  }

  /** Never throws: a deployment whose logs could not be read is left for the next start. */
  return async function backfill(): Promise<void> {
    try {
      for (const { tenantId, anchorRunId, domain } of await pending()) {
        try {
          await deployment(tenantId, anchorRunId, domain);
        } catch (err) {
          deps.log({ level: "error", msg: "triage_verdicts_backfill_failed", tenantId, deployment: anchorRunId, error: String(err) });
        }
      }
    } catch (err) {
      deps.log({ level: "error", msg: "triage_verdicts_backfill_failed", error: String(err) });
    }
  };
}
