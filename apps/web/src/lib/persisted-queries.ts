import type { Query } from "@tanstack/react-query";
import { isHiddenDosQuery } from "./held-dos.ts";
import { isHandledPullsQuery, isOpenPullsQuery } from "./open-pulls.ts";
import { isPrTimelineQuery } from "./pr-timeline.ts";
import { isRepoStatsQuery } from "./repo-stats.ts";
import { isTriageVerdictsQuery } from "./triage-verdicts.ts";

/**
 * Kept in IndexedDB across reloads: the pull requests acted on from the inbox and the Dos hidden there; and the last known
 * open pull requests and their verdicts, so the inbox shows at once and refetches; the last known triage stats of each
 * repository and readiness history of each pull request, so they show at once.
 */
export function isPersistedQuery(query: Query): boolean {
  if (isHandledPullsQuery(query) || isHiddenDosQuery(query)) return true;
  return query.state.data !== undefined && (isOpenPullsQuery(query) || isTriageVerdictsQuery(query) || isRepoStatsQuery(query) || isPrTimelineQuery(query));
}
