import { queryOptions, skipToken, useQueries, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { CATALOG_IDS, catalogCheckEnabled, checkPackName, type CheckPack } from "@corbits/triage-contracts";
import { listCheckPacks } from "./check-pack.ts";
import { createHubTransport } from "./hub-transport.ts";
import { loadCheckPackById, type CheckPackArtifact } from "./hub-api.ts";
import { usePortal } from "./portal.tsx";

export const CHECK_PACK_INDEX_QUERY_KEY = "check-pack-index";

/** One listing of every check pack, at most once per minute plus after refresh(). */
export function checkPackIndexQuery(tenantId: string) {
  return queryOptions({
    queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId],
    queryFn: () => listCheckPacks(createHubTransport(), tenantId),
    staleTime: 60_000,
  });
}

/** A repository's check pack, found through the index; the repositories table and the repository page share it. */
export function checkPackQuery(queryClient: QueryClient, tenantId: string | undefined, repo: string) {
  return queryOptions({
    queryKey: ["check-pack", tenantId, repo],
    queryFn: tenantId === undefined
      ? skipToken
      : async function readCheckPack(): Promise<CheckPackArtifact | null> {
        const listed = (await queryClient.fetchQuery(checkPackIndexQuery(tenantId))).get(checkPackName(repo));
        return listed ? loadCheckPackById(createHubTransport(), tenantId, repo, listed.id) : null;
      },
    staleTime: 60_000,
  });
}

/** Catalog checks switched on plus every custom check, which has no off state. */
export function enabledCheckCount(pack: CheckPack): number {
  return CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)).length + pack.custom.length;
}

export type PackState = { found: CheckPackArtifact | null; pending: boolean; error: Error | null };

export function useCheckPacks(repos: string[]): Map<string, PackState> {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  function byRepo(results: Array<UseQueryResult<CheckPackArtifact | null>>): Map<string, PackState> {
    return new Map(results.map((result, i) => [repos[i]!, { found: result.data ?? null, pending: result.isLoading, error: result.error }]));
  }
  return useQueries({ queries: repos.map((repo) => checkPackQuery(queryClient, tenantId, repo)), combine: byRepo });
}
