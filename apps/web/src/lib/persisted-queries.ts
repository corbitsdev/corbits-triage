import type { Query } from "@tanstack/react-query";
import { isDoRunsQuery } from "./do-runs.ts";
import { isHandledPullsQuery, isOpenPullsQuery } from "./open-pulls.ts";
import { isFinishedRunLogQuery } from "./portal.tsx";
import { isRepoStatsQuery } from "./repo-stats.ts";
import { isRunListQuery } from "./run-logs.ts";

/**
 * Kept in IndexedDB across reloads: finished run logs, which never change; the pull requests acted on from the inbox and the hub's
 * records of sent Dos; and the last known open pull requests and run lists, so the inbox shows at once and refetches; the last
 * known triage stats of each repository, so its panel shows them at once. Running logs are not kept.
 */
export function isPersistedQuery(query: Query): boolean {
  if (isFinishedRunLogQuery(query) || isHandledPullsQuery(query) || isDoRunsQuery(query)) return true;
  return query.state.data !== undefined && (isOpenPullsQuery(query) || isRunListQuery(query) || isRepoStatsQuery(query));
}
