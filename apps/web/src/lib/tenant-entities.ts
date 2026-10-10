import { skipToken, useIsFetching, useQuery } from "@tanstack/react-query";
import { ApiError, type Transport } from "@intx/hub-client";
import {
  listApprovals,
  listDeployedWorkflows,
  listGrants,
  listPrincipals,
  listRoles,
  listRuns,
  type DeployedWorkflow,
  type HubApproval,
  type HubGrant,
  type HubPrincipal,
  type HubRole,
  type HubRun,
} from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import {
  APPROVALS_QUERY_KEY,
  DEPLOYED_WORKFLOWS_QUERY_KEY,
  GRANTS_QUERY_KEY,
  PRINCIPALS_QUERY_KEY,
  ROLES_QUERY_KEY,
  RUNS_QUERY_KEY,
  usePortal,
  useSignOutWhenRejected,
} from "./portal.tsx";

const LIVE_REFRESH_MS = 10_000;
const DIRECTORY_REFRESH_MS = 60_000;
const NO_ROWS: never[] = [];

/**
 * `loading` and `unavailable` hold a page's empty state until a read lands;
 * `denied` replaces it when the hub refuses with 403.
 */
export type TenantSection<T> = { rows: T[]; loading: boolean; denied: boolean; unavailable: boolean };

function useTenantSection<T>(
  key: string,
  list: (transport: Transport, tenantId: string) => Promise<T[]>,
  refetchInterval: number,
): TenantSection<T> {
  const { snapshot } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const tenantId = snapshot?.workspace.tenantId;
  const query = useQuery({
    queryKey: [key, tenantId],
    queryFn: tenantId === undefined ? skipToken : async function readSection() {
      try {
        return await list(createHubTransport(), tenantId);
      } catch (cause: unknown) {
        signOutWhenRejected(cause);
        throw cause;
      }
    },
    refetchInterval,
  });
  const denied = query.error instanceof ApiError && query.error.status === 403;
  return {
    rows: query.data ?? NO_ROWS,
    loading: query.isLoading,
    denied,
    unavailable: query.isError && !denied,
  };
}

function isFirstRead(query: { state: { data: unknown } }): boolean {
  return query.state.data === undefined;
}

/** True while approvals are read for the first time, without subscribing, so it adds no polling of its own. */
export function useApprovalsFirstLoad(): boolean {
  return useIsFetching({ queryKey: [APPROVALS_QUERY_KEY], predicate: isFirstRead }) > 0;
}

export function useApprovals(): TenantSection<HubApproval> {
  return useTenantSection(APPROVALS_QUERY_KEY, listApprovals, LIVE_REFRESH_MS);
}

export function useRuns(): TenantSection<HubRun> {
  return useTenantSection(RUNS_QUERY_KEY, listRuns, LIVE_REFRESH_MS);
}

export function useGrants(): TenantSection<HubGrant> {
  return useTenantSection(GRANTS_QUERY_KEY, listGrants, DIRECTORY_REFRESH_MS);
}

export function usePrincipals(): TenantSection<HubPrincipal> {
  return useTenantSection(PRINCIPALS_QUERY_KEY, listPrincipals, DIRECTORY_REFRESH_MS);
}

export function useRoles(): TenantSection<HubRole> {
  return useTenantSection(ROLES_QUERY_KEY, listRoles, DIRECTORY_REFRESH_MS);
}

export function useDeployedWorkflows(): TenantSection<DeployedWorkflow> {
  return useTenantSection(DEPLOYED_WORKFLOWS_QUERY_KEY, listDeployedWorkflows, DIRECTORY_REFRESH_MS);
}
