import { queryOptions, skipToken, useQuery, type Query } from "@tanstack/react-query";
import { ApiError } from "@intx/hub-client";
import type { TriageVerdicts } from "@corbits/triage-contracts";
import { loadTriageVerdicts } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { TRIAGE_VERDICTS_QUERY_KEY, usePortal } from "./portal.tsx";

/** The hub answers 304 while nothing changed, so polling this often costs a request and no body. */
const VERDICTS_REFRESH_MS = 3_000;

function triageVerdictsQuery(tenantId: string | undefined) {
  const queryFn = tenantId === undefined ? skipToken : async function loadVerdicts() {
    return loadTriageVerdicts(createHubTransport(), tenantId);
  };
  return queryOptions({ queryKey: [TRIAGE_VERDICTS_QUERY_KEY, tenantId], queryFn, staleTime: VERDICTS_REFRESH_MS, refetchInterval: VERDICTS_REFRESH_MS });
}

function pullTriageQuery(tenantId: string | undefined, repo: string | null, number: number | null) {
  const queryFn = tenantId === undefined || repo === null || number === null ? skipToken : async function loadPull() {
    return loadTriageVerdicts(createHubTransport(), tenantId, { repo, number });
  };
  return queryOptions({ queryKey: [TRIAGE_VERDICTS_QUERY_KEY, tenantId, repo, number], queryFn, staleTime: VERDICTS_REFRESH_MS, refetchInterval: VERDICTS_REFRESH_MS });
}

/** Kept in IndexedDB, so the lists show at once after a reload and refetch. */
export function isTriageVerdictsQuery(query: Query): boolean {
  return query.queryKey[0] === TRIAGE_VERDICTS_QUERY_KEY;
}

/** `error` is a failed read other than a refusal, such as a body that does not match the hub's schema; `data` may then be stale. */
export function useTriageVerdicts(): { data: TriageVerdicts | undefined; pending: boolean; denied: boolean; error: Error | null } {
  const { snapshot } = usePortal();
  const verdicts = useQuery(triageVerdictsQuery(snapshot?.workspace.tenantId));
  const denied = verdicts.error instanceof ApiError && verdicts.error.status === 403;
  return { data: verdicts.data, pending: verdicts.isLoading, denied, error: denied ? null : verdicts.error };
}

export function usePullTriage(repo: string | null, number: number | null, enabled: boolean): TriageVerdicts | undefined {
  const { snapshot } = usePortal();
  return useQuery({ ...pullTriageQuery(snapshot?.workspace.tenantId, repo, number), enabled }).data;
}
