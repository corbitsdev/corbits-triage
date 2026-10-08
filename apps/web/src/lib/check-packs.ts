import { useMemo } from "react";
import { queryOptions, skipToken, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { CATALOG_IDS, catalogCheckEnabled, checkPackName, type CheckPack } from "@corbits/triage-contracts";
import { listCheckPackIds, loadCheckPackById } from "./check-pack.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export type PackState = { pack: CheckPack | null; pending: boolean; error: Error | null };

function checkPackIndexQuery(tenantId: string) {
  return queryOptions({
    queryKey: ["check-pack-index", tenantId],
    queryFn: () => listCheckPackIds(createHubTransport(), tenantId),
  });
}

export function checkPackQueryKey(tenantId: string | undefined, repo: string) {
  return ["check-pack", tenantId, repo] as const;
}

/** One repository's pack; the artifact id comes from the tenant-wide index, so N repositories cost one listing plus N reads. */
export function checkPackQuery(tenantId: string | undefined, repo: string) {
  return queryOptions({
    queryKey: checkPackQueryKey(tenantId, repo),
    queryFn: tenantId === undefined ? skipToken : async function fetchCheckPack({ client }) {
      const ids = await client.fetchQuery(checkPackIndexQuery(tenantId));
      const id = ids[checkPackName(repo)];
      return id ? loadCheckPackById(createHubTransport(), tenantId, repo, id) : null;
    },
  });
}

/** Catalog checks switched on plus every custom check, which has no off state. */
export function enabledCheckCount(pack: CheckPack): number {
  return CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)).length + pack.custom.length;
}

function packStates(results: Array<UseQueryResult<CheckPack | null>>): PackState[] {
  return results.map((result) => ({ pack: result.data ?? null, pending: result.isLoading, error: result.error }));
}

/** Each repository's check pack, shared through the query cache with the repository page. */
export function useCheckPacks(repos: string[]): Map<string, PackState> {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const states = useQueries({ queries: repos.map((repo) => checkPackQuery(tenantId, repo)), combine: packStates });
  return useMemo(() => new Map(repos.map((repo, i) => [repo, states[i]!])), [repos, states]);
}
