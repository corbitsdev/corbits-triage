import { projectQueue, type HubRun, type RunLog } from "./hub-api.ts";

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

/** Body children bound by `{ kind: "backlog", repo }` on their own events (`log.runId === run.id`). */
function bodyRunsForRepo(logs: RunLog[], runs: HubRun[], repoName: string): HubRun[] {
  const runIds = new Set(
    logs.filter((log) => backlogRepoFromLog(log) === repoName).map((log) => log.runId),
  );
  return runs.filter((run) => runIds.has(run.id));
}

/**
 * True while a pr-triage-historical run for this repository is live and the
 * projected queue has no item for it yet.
 */
export function isRepoCatchingUp(logs: RunLog[], runs: HubRun[], repoName: string): boolean {
  if (projectQueue(logs, runs, []).some((item) => item.repo === repoName)) return false;
  return bodyRunsForRepo(logs, runs, repoName).some((run) => isLiveStatus(run.status));
}
