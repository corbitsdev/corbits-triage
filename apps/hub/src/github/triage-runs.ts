// Every pr-triage run a tenant has, read from the committed run event logs and
// keyed by the pull request head its trigger named.
import { and, eq, inArray, ne } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunReader } from "@intx/hub-sessions";
import { runKey, type ObservedRun } from "./reconcile-plan.js";

const TERMINAL_EVENTS: Record<string, ObservedRun["status"]> = {
  RunCompleted: "completed",
  RunFailed: "failed",
  RunCancelled: "cancelled",
};
const SETTLED_STATUSES = new Set<string>(["completed", "failed", "cancelled"]);

type Trigger = { repo: string; number: number; headSha: string; startedAt: string };

/** Runs by repository, then by `runKey`. */
export type ObservedRuns = Map<string, Map<string, ObservedRun[]>>;

export type TriageRunsDeps = {
  db: DB["db"];
  runReader: WorkflowRunReader;
  /** The deployed workflow whose runs triage one pull request. */
  workflowName: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsePayload(payload: unknown): Record<string, unknown> | undefined {
  if (typeof payload !== "string") return asRecord(payload);
  try {
    return asRecord(JSON.parse(payload));
  } catch {
    return undefined;
  }
}

/** Null for runs that name no single pull request head, such as a portal run typed without a sha. */
function triggerOf(started: Record<string, unknown>): Trigger | null {
  const payload = parsePayload(asRecord(started["trigger"])?.["payload"]);
  const repo = payload?.["repo"];
  const number = payload?.["prNumber"];
  const headSha = payload?.["headSha"];
  const startedAt = started["at"];
  if (payload?.["kind"] !== "pr" || typeof repo !== "string" || typeof number !== "number" || typeof headSha !== "string" || headSha === "") return null;
  if (typeof startedAt !== "string") return null;
  return { repo, number, headSha, startedAt };
}

export function createTriageRuns(deps: TriageRunsDeps) {
  // A run's trigger never changes, so each log is opened once per hub process.
  const triggers = new Map<string, Trigger | null>();

  async function triggerFor(repoId: ReturnType<typeof workflowRunRepoIdForAddress>, runId: string): Promise<Trigger | null> {
    const cached = triggers.get(runId);
    if (cached !== undefined) return cached;
    const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
    const started = events.find((event) => event.type === "RunStarted");
    // A run that has not committed RunStarted yet is read again next pass.
    if (!started) return null;
    const trigger = triggerOf(started.body);
    triggers.set(runId, trigger);
    return trigger;
  }

  async function anchorsOf(tenantId: string): Promise<string[]> {
    const { workflowRun, workflowDefinition } = schema;
    const rows = await deps.db
      .select({ id: workflowRun.id })
      .from(workflowRun)
      .innerJoin(workflowDefinition, eq(workflowRun.definitionId, workflowDefinition.id))
      .where(and(
        eq(workflowRun.tenantId, tenantId),
        eq(workflowDefinition.name, deps.workflowName),
        eq(workflowRun.id, workflowRun.anchorRunId),
      ));
    return rows.map((row) => row.id);
  }

  /** The stock lifecycle settles runs whose sidecar is gone without a terminal event in the log. */
  async function settledStatuses(anchors: string[]): Promise<Map<string, ObservedRun["status"]>> {
    if (anchors.length === 0) return new Map();
    const { workflowRun } = schema;
    const rows = await deps.db
      .select({ id: workflowRun.id, status: workflowRun.status })
      .from(workflowRun)
      .where(and(inArray(workflowRun.anchorRunId, anchors), ne(workflowRun.id, workflowRun.anchorRunId)));
    return new Map(rows.flatMap((row) => (SETTLED_STATUSES.has(row.status) ? [[row.id, row.status as ObservedRun["status"]]] : [])));
  }

  return async function observeRuns(tenantId: string, domain: string): Promise<ObservedRuns> {
    const anchors = await anchorsOf(tenantId);
    const settled = await settledStatuses(anchors);
    const observed: ObservedRuns = new Map();
    for (const anchorId of anchors) {
      const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorId, domain));
      const { events } = await deps.runReader.readLatestRunEvents(repoId, WORKFLOW_RUN_REF, (runId) => runId !== anchorId);
      for (const [runId, latest] of events) {
        const trigger = await triggerFor(repoId, runId);
        if (!trigger) continue;
        const status = (latest && TERMINAL_EVENTS[latest.type]) ?? settled.get(runId) ?? "running";
        const byHead = observed.get(trigger.repo) ?? new Map<string, ObservedRun[]>();
        observed.set(trigger.repo, byHead);
        const key = runKey(trigger.number, trigger.headSha);
        byHead.set(key, [...(byHead.get(key) ?? []), { runId, status, startedAt: trigger.startedAt }]);
      }
    }
    return observed;
  };
}
