import { useCallback } from "react";
import { queryOptions, skipToken, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CATALOG_IDS, catalogCheckEnabled, type CheckPack } from "@corbits/triage-contracts";
import { listCheckPacks } from "./check-pack.ts";
import { createHubTransport } from "./hub-transport.ts";
import { loadRepoCheckPack, type CheckPackArtifact } from "./hub-api.ts";
import { usePortal } from "./portal.tsx";

export const CHECK_PACK_INDEX_QUERY_KEY = "check-pack-index";

/** At most once per minute plus after refresh(). */
export function checkPackIndexQuery(tenantId: string) {
  return queryOptions({
    queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId],
    queryFn: () => listCheckPacks(createHubTransport(), tenantId),
    staleTime: 60_000,
  });
}

export function checkPackQuery(tenantId: string | undefined, repo: string) {
  return queryOptions({
    queryKey: ["check-pack", tenantId, repo],
    queryFn: tenantId === undefined
      ? skipToken
      : function readCheckPack(): Promise<CheckPackArtifact | null> {
        return loadRepoCheckPack(createHubTransport(), tenantId, repo);
      },
    staleTime: 60_000,
  });
}

export function useRepoPack(repo: string): CheckPack | null {
  const { snapshot } = usePortal();
  const found = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo)).data;
  return found && "pack" in found ? found.pack : null;
}

/** Catalog checks switched on plus every custom check, which has no off state. */
export function enabledCheckCount(pack: CheckPack): number {
  return CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)).length + pack.custom.length;
}

export type PackState = { found: CheckPackArtifact | null; pending: boolean; error: Error | null };

export function useCheckPacks(repos: string[]): Map<string, PackState> {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  // A stable combine lets TanStack hand back the same Map until a result changes.
  const byRepo = useCallback(function byRepo(results: Array<UseQueryResult<CheckPackArtifact | null>>): Map<string, PackState> {
    return new Map(results.map((result, i) => [repos[i]!, { found: result.data ?? null, pending: result.isLoading, error: result.error }]));
  }, [repos]);
  return useQueries({ queries: repos.map((repo) => checkPackQuery(tenantId, repo)), combine: byRepo });
}
