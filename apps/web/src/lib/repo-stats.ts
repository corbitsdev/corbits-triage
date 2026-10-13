import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import type { TriageStats } from "@corbits/triage-contracts";
import type { RepoPackStore } from "./repo-pack-store.ts";

const REPO_STATS_QUERY_KEY = "triage-stats";

/** The window the portal shows a repository's stats over. */
export const WEEK_DAYS = 7;

/** The hub caches the stats for a minute, so reading sooner returns the same answer. */
export function repoStatsQuery(store: RepoPackStore | null, repo: string, days: number) {
  const queryFn = store === null ? skipToken : async function loadStats() {
    return store.loadStats(repo, days);
  };
  return queryOptions({ queryKey: [REPO_STATS_QUERY_KEY, store?.tenantId, repo, days], queryFn, staleTime: 60_000 });
}

export function isRepoStatsQuery(query: Query): boolean {
  return query.queryKey[0] === REPO_STATS_QUERY_KEY;
}

/** Undefined while loading or after a failure. */
export function useRepoStats(store: RepoPackStore | null, repo: string, days = WEEK_DAYS): TriageStats | undefined {
  return useQuery(repoStatsQuery(store, repo, days)).data;
}

const MINUTE = 60_000;

export function medianText(ms: number | null): string {
  if (ms === null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(ms / MINUTE);
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

/** Dos the hub ran for the repository's verdicts. */
export function actedOn(stats: TriageStats): number {
  return Object.values(stats.actions).reduce((sum, action) => sum + action.executed, 0);
}
