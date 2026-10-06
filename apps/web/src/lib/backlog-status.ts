import {
  backlogSyncFromConfig,
  projectQueue,
  type HubRun,
  type PortalSnapshot,
  type RunLog,
} from "./hub-api.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function eventPayload(body: unknown): Record<string, unknown> {
  const row = record(body);
  const trigger = record(row.trigger);
  return record(parseJson(trigger.payload ?? row.payload ?? row.content));
}

function backlogRepoFromLog(log: RunLog): string | null {
  for (const event of log.events) {
    const payload = eventPayload(event.body);
    if (payload.kind === "backlog" && typeof payload.repo === "string") return payload.repo;
  }
  return null;
}

function isLiveStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "running" || normalized === "deployed" || normalized === "pending";
}

function isCompletedStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "completed" || normalized === "succeeded";
}

/** Body children bound by `{ kind: "backlog", repo }` on their own events (`log.runId === run.id`). */
function bodyRunsForRepo(snapshot: PortalSnapshot, repoName: string): HubRun[] {
  const runIds = new Set(
    snapshot.logs.filter((log) => backlogRepoFromLog(log) === repoName).map((log) => log.runId),
  );
  return snapshot.runs.filter((run) => runIds.has(run.id));
}

/**
 * True while this repository's backlog scan is still in flight.
 * Failed sync stays false so Repositories can Retry. Classification in the
 * projected queue, or a completed pr-triage-historical run for the repo, clears it
 * even when config is still pending (the hub never writes succeeded).
 */
export function isRepoCatchingUp(snapshot: PortalSnapshot, repoName: string): boolean {
  const sync = backlogSyncFromConfig(snapshot.config)[repoName];
  if (sync?.status === "failed") return false;
  if (projectQueue(snapshot).some((item) => item.repo === repoName)) return false;
  const runs = bodyRunsForRepo(snapshot, repoName);
  if (runs.some((run) => isLiveStatus(run.status))) return true;
  if (sync?.status !== "pending") return false;
  return !runs.some((run) => isCompletedStatus(run.status));
}
