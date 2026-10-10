import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import type { TriageStats } from "./hub-api.ts";
import type { RepoPackStore } from "./repo-pack-store.ts";

const REPO_STATS_QUERY_KEY = "triage-stats";

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
export function useRepoStats(store: RepoPackStore | null, repo: string, days = 7): TriageStats | undefined {
  return useQuery(repoStatsQuery(store, repo, days)).data;
}
