import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RepoSource } from "@corbits/triage-contracts";
import { switchBitbucketDatacenterTriage } from "./bitbucket-datacenter.ts";
import { saveRepoSettings } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { POLICY_UPGRADES_QUERY_KEY } from "./policy-upgrades.ts";
import { usePortal, useSignOutWhenRejected } from "./portal.tsx";

/**
 * Switching triage on or off for a repository. A Bitbucket Data Center repository is switched by the hub's routes; a
 * GitHub one through the workspace's settings, and switching it on with a rule on triages its open pull requests, as
 * only GitHub's backlog route can. The policy file standing lists only enabled repositories, so it is read again.
 */
export function useTriageSwitch(repo: string, source: RepoSource, ruleOn: boolean) {
  const { snapshot, refreshNow, runBacklog } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;

  return useMutation({
    mutationFn: async function switchTriage(enabled: boolean) {
      if (tenantId === undefined) throw new Error("The workspace is not known yet.");
      const transport = createHubTransport();
      if (source === "bitbucket-datacenter") await switchBitbucketDatacenterTriage(queryClient, transport, tenantId, repo, enabled);
      else await saveRepoSettings(transport, tenantId, repo, source, { enabled });
      await queryClient.invalidateQueries({ queryKey: [POLICY_UPGRADES_QUERY_KEY, tenantId] });
      if (source === "github" && enabled && ruleOn) await runBacklog(repo, "Triage enabled. Triaging open pull requests.");
      await refreshNow();
    },
    onError: signOutWhenRejected,
  });
}
