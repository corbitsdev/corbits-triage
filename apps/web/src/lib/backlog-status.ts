import { triggerRequestOf } from "@corbits/triage-contracts";
import { projectQueue, type HubRun, type RunLog } from "./hub-api.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function eventPayload(body: unknown): Record<string, unknown> {
  const row = record(body);
  const trigger = record(row.trigger);
  return record(triggerRequestOf(trigger.payload ?? row.payload ?? row.content));
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

/**
 * Repositories with a live pr-triage-historical run, bound by `{ kind: "backlog", repo }`
 * on its own events, and no projected queue item yet.
 */
export function catchingUpRepos(logs: RunLog[], runs: HubRun[]): Set<string> {
  const queued = new Set(projectQueue(logs, runs, [], undefined, new Date()).map((item) => item.repo));
  const live = new Set(runs.filter((run) => isLiveStatus(run.status)).map((run) => run.id));
  const repos = new Set<string>();
  for (const log of logs) {
    const repo = backlogRepoFromLog(log);
    if (repo !== null && !queued.has(repo) && live.has(log.runId)) repos.add(repo);
  }
  return repos;
}

export function isRepoCatchingUp(logs: RunLog[], runs: HubRun[], repoName: string): boolean {
  return catchingUpRepos(logs, runs).has(repoName);
}
