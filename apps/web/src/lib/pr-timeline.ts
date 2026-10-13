import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import { loadTriageTimeline } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const PR_TIMELINE_QUERY_KEY = "triage-timeline";

export function prTimelineQuery(tenantId: string | undefined, repo: string, number: number | null) {
  const queryFn = tenantId === undefined || number === null ? skipToken : async function loadTimeline() {
    return loadTriageTimeline(createHubTransport(), tenantId, repo, number);
  };
  return queryOptions({ queryKey: [PR_TIMELINE_QUERY_KEY, tenantId, repo, number], queryFn, staleTime: 60_000 });
}

export function isPrTimelineQuery(query: Query): boolean {
  return query.queryKey[0] === PR_TIMELINE_QUERY_KEY;
}

/** A pull request's recorded verdicts, oldest first. */
export function usePrTimeline(repo: string, number: number | null) {
  const { snapshot } = usePortal();
  return useQuery(prTimelineQuery(snapshot?.workspace.tenantId, repo, number));
}
