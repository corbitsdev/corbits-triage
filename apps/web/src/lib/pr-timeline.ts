import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import { useDoRuns } from "./do-runs.ts";
import { loadTriageTimeline, type DoRun, type TimelineEntry } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const PR_TIMELINE_QUERY_KEY = "triage-timeline";

export type TimelineItem = { type: "verdict"; at: string; verdict: TimelineEntry } | { type: "do"; at: string; run: DoRun };

export function prTimelineQuery(tenantId: string | undefined, repo: string, number: number | null) {
  const queryFn = tenantId === undefined || number === null ? skipToken : async function loadTimeline() {
    return loadTriageTimeline(createHubTransport(), tenantId, repo, number);
  };
  return queryOptions({ queryKey: [PR_TIMELINE_QUERY_KEY, tenantId, repo, number], queryFn, staleTime: 60_000 });
}

export function isPrTimelineQuery(query: Query): boolean {
  return query.queryKey[0] === PR_TIMELINE_QUERY_KEY;
}

/** The hub stamps both with `toISOString`, so the strings sort in time order. */
function byTime(a: TimelineItem, b: TimelineItem): number {
  return a.at.localeCompare(b.at);
}

/** A pull request's recorded verdicts merged with its Do runs, oldest first; the Do runs are the cache the inbox already keeps. */
export function usePrTimeline(repo: string, number: number | null) {
  const { snapshot } = usePortal();
  const timeline = useQuery(prTimelineQuery(snapshot?.workspace.tenantId, repo, number));
  const runs = useDoRuns(repo, number);
  const items: TimelineItem[] = [
    ...(timeline.data?.entries ?? []).map((verdict) => ({ type: "verdict" as const, at: verdict.at, verdict })),
    ...(runs.data ?? []).map((run) => ({ type: "do" as const, at: run.updatedAt, run })),
  ].toSorted(byTime);
  return { items, isPending: timeline.isPending || runs.isPending, error: timeline.error ?? runs.error };
}
