import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import type { OutcomeMedians, RepoSource, TriageOutcomes, TriageStats } from "@corbits/triage-contracts";
import { hostName } from "./pull-link.ts";
import type { RepoPackStore } from "./repo-pack-store.ts";

const REPO_STATS_QUERY_KEY = "triage-stats";

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
  const days = Math.floor(hours / 24);
  if (days > 0) return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

export type OutcomeField = Exclude<keyof OutcomeMedians, "prs" | "closed">;

export const OUTCOME_NAMES: Record<OutcomeField, string> = {
  mergeOrCloseMs: "Merge or close",
  firstHumanResponseMs: "First response",
  firstApprovalMs: "First approval",
  humanTouchGapMs: "Longest wait",
};

export type OutcomesView = { missing: string } | { triaged: OutcomeMedians; baseline: OutcomeMedians | null; baselineMissing: string | null };

function noAnswer(source: RepoSource): string {
  return `${hostName(source)} did not answer; the numbers will return when it does.`;
}

function baselineMissing(outcomes: Extract<TriageOutcomes, { state: "measured" }>, source: RepoSource): string | null {
  if (outcomes.baselineState === "no_policy") return "The baseline needs a saved policy.";
  if (outcomes.baselineState === "source_failed") return noAnswer(source);
  if (outcomes.baseline === null) return "No pull requests closed before Triage was switched on.";
  return null;
}

/** The triaged medians beside the baseline, or why either is missing as one sentence. */
export function outcomesView(outcomes: TriageOutcomes | null, source: RepoSource): OutcomesView {
  if (outcomes === null) return { missing: `Not connected to ${hostName(source)}.` };
  if (outcomes.state === "measured") return { triaged: outcomes.triaged, baseline: outcomes.baseline, baselineMissing: baselineMissing(outcomes, source) };
  if (outcomes.state === "no_credential") return { missing: `Needs a ${hostName(source)} credential you can use.` };
  return { missing: noAnswer(source) };
}

export function outcomeCounts(medians: OutcomeMedians): string {
  return `${medians.prs} PRs, ${medians.closed} closed`;
}

export function actedOn(stats: TriageStats): number {
  return Object.values(stats.actions).reduce((sum, action) => sum + action.executed, 0);
}
