// The live pr-triage deployment's runs, read from its committed run event log
// and keyed by the pull request head their trigger named.
import { and, eq, inArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { formatRunAddress } from "@intx/types";
import { WORKFLOW_RUN_REF, workflowRunRepoIdForAddress, type WorkflowRunEvent, type WorkflowRunReader } from "@intx/hub-sessions";
import { runKey, type ObservedRun } from "./reconcile-plan.js";

const TERMINAL_EVENTS: Record<string, Terminal["status"]> = {
  RunCompleted: "completed",
  RunFailed: "failed",
  RunCancelled: "cancelled",
};
const INLINE_PREFIX = "inline:";
const NO_VERDICT = "run completed without a verdict";

type Trigger = { repo: string; number: number; headSha: string; startedAt: string };
type Terminal = { status: Exclude<ObservedRun["status"], "running">; degraded?: string };
/** A null trigger names no single pull request head, such as a portal run typed without a sha. */
type KnownRun = { anchorRunId: string; trigger: Trigger | null; terminal?: Terminal };

/** Runs by repository, then by `runKey`. */
export type ObservedRuns = Map<string, Map<string, ObservedRun[]>>;

/** Statuses the stock lifecycle settled for these runs, which it can do without a terminal event in the log. */
export type ReadSettled = (anchorRunId: string, runIds: string[]) => Promise<Map<string, Terminal["status"]>>;

export type TriageRunsDeps = {
  runReader: WorkflowRunReader;
  readSettled: ReadSettled;
  /** Runs remembered at most; the oldest is forgotten first and read again while it is still in the log. */
  maxKnownRuns: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function triggerOf(started: Record<string, unknown>): Trigger | null {
  const payload = asRecord(parseJson(asRecord(started["trigger"])?.["payload"]));
  const repo = payload?.["repo"];
  const number = payload?.["prNumber"];
  const headSha = payload?.["headSha"];
  const startedAt = started["at"];
  if (payload?.["kind"] !== "pr" || typeof repo !== "string" || typeof number !== "number" || typeof headSha !== "string" || headSha === "") return null;
  if (typeof startedAt !== "string") return null;
  return { repo, number, headSha, startedAt };
}

function isRenderCompleted(event: WorkflowRunEvent): boolean {
  return event.type === "StepCompleted" && String(event.body["stepId"]).split(/[/.]/).pop() === "render";
}

/** The render step's reply is the verdict; a degraded one carries its reason. */
function degradedReason(events: readonly WorkflowRunEvent[]): string | undefined {
  const ref = asRecord(events.findLast(isRenderCompleted)?.body["output"])?.["ref"];
  if (typeof ref !== "string" || !ref.startsWith(INLINE_PREFIX)) return NO_VERDICT;
  const verdict = asRecord(parseJson(asRecord(parseJson(ref.slice(INLINE_PREFIX.length)))?.["reply"]));
  if (!verdict) return NO_VERDICT;
  const degraded = verdict["degraded"];
  if (degraded === undefined || degraded === null) return undefined;
  const reason = verdict["reason"];
  return typeof reason === "string" && reason !== "" ? reason : String(degraded);
}

function terminalOf(events: readonly WorkflowRunEvent[]): Terminal | undefined {
  const status = TERMINAL_EVENTS[events.at(-1)?.type ?? ""];
  if (status === undefined) return undefined;
  if (status !== "completed") return { status };
  const degraded = degradedReason(events);
  return degraded === undefined ? { status } : { status, degraded };
}

export function createSettledStatusReader(db: DB["db"]): ReadSettled {
  return async function readSettled(anchorRunId, runIds) {
    if (runIds.length === 0) return new Map();
    const { workflowRun } = schema;
    const rows = await db
      .select({ id: workflowRun.id, status: workflowRun.status })
      .from(workflowRun)
      .where(and(eq(workflowRun.anchorRunId, anchorRunId), inArray(workflowRun.id, runIds), inArray(workflowRun.status, ["failed", "cancelled"])));
    return new Map(rows.map((row) => [row.id, row.status as Terminal["status"]]));
  };
}

export function createTriageRuns(deps: TriageRunsDeps) {
  // Insertion-ordered, so the first key is the oldest.
  const known = new Map<string, KnownRun>();

  function remember(runId: string, run: KnownRun): void {
    known.delete(runId);
    known.set(runId, run);
    if (known.size > deps.maxKnownRuns) known.delete(known.keys().next().value!);
  }

  /** A finished log never changes, so a settled run is never read again. */
  function settledRuns(anchorRunId: string): Set<string> {
    const ids = new Set<string>();
    for (const [runId, run] of known) {
      if (run.anchorRunId === anchorRunId && (run.trigger === null || run.terminal !== undefined)) ids.add(runId);
    }
    return ids;
  }

  return async function observeRuns(anchorRunId: string, domain: string): Promise<ObservedRuns> {
    const repoId = workflowRunRepoIdForAddress(formatRunAddress(anchorRunId, domain));
    const settledIds = settledRuns(anchorRunId);
    const { events: latest } = await deps.runReader.readLatestRunEvents(
      repoId,
      WORKFLOW_RUN_REF,
      (runId) => runId !== anchorRunId && !settledIds.has(runId),
    );
    const open: string[] = [];
    for (const [runId, event] of latest) {
      const ended = event !== null && TERMINAL_EVENTS[event.type] !== undefined;
      if (known.has(runId) && !ended) {
        open.push(runId);
        continue;
      }
      const events = await deps.runReader.readRunEvents(repoId, WORKFLOW_RUN_REF, runId);
      const started = events.find((e) => e.type === "RunStarted");
      // A run that has not committed RunStarted yet is read again next pass.
      if (!started) continue;
      const trigger = triggerOf(started.body);
      const terminal = terminalOf(events);
      remember(runId, { anchorRunId, trigger, ...(terminal !== undefined && { terminal }) });
      if (trigger !== null && terminal === undefined) open.push(runId);
    }
    const settled = await deps.readSettled(anchorRunId, open);
    for (const [runId, status] of settled) {
      const run = known.get(runId);
      if (run) remember(runId, { ...run, terminal: { status } });
    }

    const observed: ObservedRuns = new Map();
    for (const runId of [...settledIds, ...latest.keys()]) {
      const run = known.get(runId);
      if (!run?.trigger) continue;
      const { repo, number, headSha, startedAt } = run.trigger;
      const byHead = observed.get(repo) ?? new Map<string, ObservedRun[]>();
      observed.set(repo, byHead);
      const key = runKey(number, headSha);
      const degraded = run.terminal?.degraded;
      const seen: ObservedRun = { runId, status: run.terminal?.status ?? "running", startedAt, ...(degraded !== undefined && { degraded }) };
      byHead.set(key, [...(byHead.get(key) ?? []), seen]);
    }
    return observed;
  };
}
