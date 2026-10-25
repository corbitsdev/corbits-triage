import { asRecord } from "@corbits/common";
import { repoSourceOf, triggerRequestOf } from "@corbits/triage-contracts";
import type { HubRun, RunLog } from "./hub-api.ts";
import { sameRepo, type RepoId } from "./repo-rows.ts";

function eventPayload(body: unknown): Record<string, unknown> {
  const row = asRecord(body) ?? {};
  const trigger = asRecord(row.trigger) ?? {};
  return asRecord(triggerRequestOf(trigger.payload ?? row.payload ?? row.content)) ?? {};
}

function backlogRepoFromLog(log: RunLog): RepoId | null {
  for (const event of log.events) {
    const payload = eventPayload(event.body);
    if (payload.kind === "backlog" && typeof payload.repo === "string") return { name: payload.repo, source: repoSourceOf(payload.repoSource) };
  }
  return null;
}

function isLiveStatus(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized === "running" || normalized === "deployed" || normalized === "pending";
}

/**
 * Repositories with a live pr-triage-historical run, bound by `{ kind: "backlog", repo, repoSource }`
 * on its own events, and no pr-triage run yet; `triaged` are the repositories that have one, each on its host.
 */
export function catchingUpRepos(logs: RunLog[], runs: HubRun[], triaged: readonly RepoId[]): RepoId[] {
  const live = new Set(runs.filter((run) => isLiveStatus(run.status)).map((run) => run.id));
  const repos: RepoId[] = [];
  for (const log of logs) {
    const repo = backlogRepoFromLog(log);
    if (repo !== null && live.has(log.runId) && ![...triaged, ...repos].some((row) => sameRepo(row, repo))) repos.push(repo);
  }
  return repos;
}

export function isRepoCatchingUp(logs: RunLog[], runs: HubRun[], triaged: readonly RepoId[], repo: RepoId): boolean {
  return catchingUpRepos(logs, runs, triaged).some((row) => sameRepo(row, repo));
}
