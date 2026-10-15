import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { disableBitbucketDatacenterRepository } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { isOpenPullsQuery } from "./open-pulls.ts";
import { usePortal } from "./portal.tsx";
import { isRepoStatsQuery } from "./repo-stats.ts";

/** A Bitbucket Data Center record is disabled first, because only the hub's route removes the webhook triage created. */
export function useRemoveRepository(repo: string, source: RepoSource, onRemoved: () => void) {
  const queryClient = useQueryClient();
  const { snapshot, removeRepo, refreshNow, warn } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: async function remove() {
      if (source === "bitbucket-datacenter") {
        if (tenantId === undefined) throw new Error("Open a workspace first.");
        const { webhookLeft } = await disableBitbucketDatacenterRepository(createHubTransport(), tenantId, repo);
        if (webhookLeft) warn(`Delete the Corbits Triage webhook on ${repo} by hand; Triage could not remove it.`);
      }
      await removeRepo(repo);
    },
    onSuccess: async function leave() {
      await Promise.all([
        queryClient.invalidateQueries({ predicate: isOpenPullsQuery }),
        queryClient.invalidateQueries({ predicate: isRepoStatsQuery }),
        refreshNow(),
      ]);
      onRemoved();
    },
  });
}
