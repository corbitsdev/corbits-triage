import { useCallback } from "react";
import { queryOptions, skipToken, useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { CATALOG_IDS, catalogCheckEnabled, repoSourceOf, type ActionKind, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { createHubTransport } from "./hub-transport.ts";
import { loadRepoCheckPack, type CheckPackArtifact } from "./hub-api.ts";
import { usePortal } from "./portal.tsx";
import { repoKey, type RepoId } from "./repo-rows.ts";

export function checkPackQuery(tenantId: string | undefined, repo: string, source: RepoSource) {
  return queryOptions({
    queryKey: ["check-pack", tenantId, repo, source],
    queryFn: tenantId === undefined
      ? skipToken
      : function readCheckPack(): Promise<CheckPackArtifact | null> {
        return loadRepoCheckPack(createHubTransport(), tenantId, repo, source);
      },
    staleTime: 60_000,
  });
}

export function useRepoPack(repo: string, source: RepoSource): CheckPack | null {
  const { snapshot } = usePortal();
  return packOf(useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo, source)).data);
}

/** Whether the repository's policy file turns code review on. */
export function useCodeReviewOn(repo: string, source: RepoSource): boolean {
  const { snapshot } = usePortal();
  const found = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo, source)).data;
  return found?.kind === "file" && found.codeReview;
}

/** The kinds the repository's policy file has Triage take on its own; none while it has no file Triage runs. */
export function useRepoWanted(repo: string, source: RepoSource): ActionKind[] {
  const { snapshot } = usePortal();
  const found = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo, source)).data;
  return found?.kind === "file" ? found.wanted : [];
}

export function packOf(found: CheckPackArtifact | null | undefined): CheckPack | null {
  return found && "pack" in found ? found.pack : null;
}

/** Catalog checks switched on plus every custom check, which has no off state. */
export function enabledCheckCount(pack: CheckPack): number {
  return CATALOG_IDS.filter((id) => catalogCheckEnabled(pack, id)).length + pack.custom.length;
}

export type PackState = { found: CheckPackArtifact | null; pending: boolean; error: Error | null };

/** Each repository's pack under its `repoKey`. */
export function useCheckPacks(repos: readonly RepoId[]): Map<string, PackState> {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  // A stable combine lets TanStack hand back the same Map until a result changes.
  const byRepo = useCallback(function byRepo(results: Array<UseQueryResult<CheckPackArtifact | null>>): Map<string, PackState> {
    return new Map(results.map((result, i) => [repoKey(repos[i]!), { found: result.data ?? null, pending: result.isLoading, error: result.error }]));
  }, [repos]);
  return useQueries({ queries: repos.map((repo) => checkPackQuery(tenantId, repo.name, repoSourceOf(repo.source))), combine: byRepo });
}
