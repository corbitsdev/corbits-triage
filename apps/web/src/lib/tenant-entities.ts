import { skipToken, useIsFetching, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, type Transport } from "@intx/hub-client";
import type { DeployedVersions } from "@corbits/triage-contracts";
import {
  evaluateAccess,
  listApprovals,
  listPrincipals,
  listRoles,
  readDeployedVersions,
  type DeployedWorkflow,
  type HubApproval,
  type HubPrincipal,
  type HubRole,
} from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import {
  ALLOWED_QUERY_KEY,
  APPROVALS_QUERY_KEY,
  DEPLOYED_VERSIONS_QUERY_KEY,
  PRINCIPALS_QUERY_KEY,
  ROLES_QUERY_KEY,
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

function useTenantRead<R>(key: string, read: (transport: Transport, tenantId: string) => Promise<R>, refetchInterval: number): UseQueryResult<R> {
  const { snapshot } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const tenantId = snapshot?.workspace.tenantId;
  return useQuery({
    queryKey: [key, tenantId],
    queryFn: tenantId === undefined ? skipToken : async function readSection() {
      try {
        return await read(createHubTransport(), tenantId);
      } catch (cause: unknown) {
        signOutWhenRejected(cause);
        throw cause;
      }
    },
    refetchInterval,
  });
}

function sectionOf<R, T>(query: UseQueryResult<R>, rows: (data: R) => T[]): TenantSection<T> {
  const denied = query.error instanceof ApiError && query.error.status === 403;
  return {
    rows: query.data === undefined ? NO_ROWS : rows(query.data),
    loading: query.isLoading,
    denied,
    unavailable: query.isError && !denied,
  };
}

function isFirstRead(query: { state: { data: unknown } }): boolean {
  return query.state.data === undefined;
}

/** Adds no polling of its own. */
export function useApprovalsFirstLoad(): boolean {
  return useIsFetching({ queryKey: [APPROVALS_QUERY_KEY], predicate: isFirstRead }) > 0;
}

function useTenantSection<T>(key: string, list: (transport: Transport, tenantId: string) => Promise<T[]>, refetchInterval: number): TenantSection<T> {
  return sectionOf(useTenantRead(key, list, refetchInterval), (rows) => rows);
}

export function useApprovals(): TenantSection<HubApproval> {
  return useTenantSection(APPROVALS_QUERY_KEY, listApprovals, LIVE_REFRESH_MS);
}

export function usePrincipals(): TenantSection<HubPrincipal> {
  return useTenantSection(PRINCIPALS_QUERY_KEY, listPrincipals, DIRECTORY_REFRESH_MS);
}

export function useRoles(): TenantSection<HubRole> {
  return useTenantSection(ROLES_QUERY_KEY, listRoles, DIRECTORY_REFRESH_MS);
}

export type DeployedSection = TenantSection<DeployedWorkflow> & { rollouts: DeployedVersions["rollouts"] };

/** The live deployments and the hub's last roll of each host, read often so a roll's outcome shows soon after it ends. */
export function useDeployedVersions(): DeployedSection {
  const query = useTenantRead(DEPLOYED_VERSIONS_QUERY_KEY, readDeployedVersions, LIVE_REFRESH_MS);
  return { ...sectionOf(query, (versions) => versions.deployments), rollouts: query.data?.rollouts ?? NO_ROWS };
}

export function useAccess(resource: string, action: string): UseQueryResult<boolean> {
  const { snapshot } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const workspace = snapshot?.workspace;
  return useQuery({
    queryKey: [ALLOWED_QUERY_KEY, workspace?.tenantId, workspace?.principalId, resource, action],
    queryFn: workspace === undefined ? skipToken : async function readAllowed() {
      try {
        return await evaluateAccess(createHubTransport(), workspace.tenantId, workspace.principalId, resource, action);
      } catch (cause: unknown) {
        signOutWhenRejected(cause);
        throw cause;
      }
    },
    staleTime: DIRECTORY_REFRESH_MS,
  });
}

export function useAllowed(resource: string, action: string): boolean {
  return useAccess(resource, action).data === true;
}
