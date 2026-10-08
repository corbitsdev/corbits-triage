import { queryOptions, skipToken, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { CATALOG_IDS, catalogCheckEnabled, type CheckPack } from "@corbits/triage-contracts";
import { loadCheckPack } from "./check-pack.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export type PackState = { pack: CheckPack | null; pending: boolean; error: Error | null };

export function checkPackQueryKey(tenantId: string | undefined, repo: string) {
  return ["check-pack", tenantId, repo] as const;
}

function checkPackQuery(tenantId: string | undefined, repo: string) {
  return queryOptions({
    queryKey: checkPackQueryKey(tenantId, repo),
    queryFn: tenantId === undefined ? skipToken : () => loadCheckPack(createHubTransport(), tenantId, repo),
  });
}

/** Catalog checks switched on plus every custom check, which has no off state. */
export function enabledCheckCount(pack: CheckPack): number {
  return CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)).length + pack.custom.length;
}

/** Each repository's check pack, read once per repository and shared through the query cache. */
export function useCheckPacks(repos: string[]): Map<string, PackState> {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  function byRepo(results: Array<UseQueryResult<CheckPack | null>>): Map<string, PackState> {
    return new Map(results.map((result, i) => [repos[i]!, { pack: result.data ?? null, pending: result.isLoading, error: result.error }]));
  }
  return useQueries({ queries: repos.map((repo) => checkPackQuery(tenantId, repo)), combine: byRepo });
}
