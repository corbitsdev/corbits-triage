import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { loadTriageTimeline } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

const PR_TIMELINE_QUERY_KEY = "triage-timeline";

function prTimelineQuery(tenantId: string | undefined, repo: string, number: number | null, source?: RepoSource) {
  const queryFn = tenantId === undefined || number === null ? skipToken : async function loadTimeline() {
    return loadTriageTimeline(createHubTransport(), tenantId, repo, number, source);
  };
  return queryOptions({ queryKey: [PR_TIMELINE_QUERY_KEY, tenantId, source, repo, number], queryFn, staleTime: 60_000 });
}

export function isPrTimelineQuery(query: Query): boolean {
  return query.queryKey[0] === PR_TIMELINE_QUERY_KEY;
}

export function usePrTimeline(repo: string, number: number | null, source?: RepoSource) {
  const { snapshot } = usePortal();
  return useQuery(prTimelineQuery(snapshot?.workspace.tenantId, repo, number, source));
}
