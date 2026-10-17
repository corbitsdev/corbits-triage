import { queryOptions, skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PolicyUpgrades } from "@corbits/triage-contracts";
import { archiveArtifact, exportPolicyFile, loadPolicyUpgrades } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

function policyUpgradesQuery(tenantId: string | undefined) {
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyUpgrades() {
    return loadPolicyUpgrades(createHubTransport(), tenantId);
  };
  // A merge on the host changes a repository's standing without the portal knowing, so each load reads it again.
  return queryOptions({ queryKey: ["policy-upgrades", tenantId], queryFn, staleTime: 60_000, refetchOnMount: "always" });
}

function useUpgradeRows(): PolicyUpgradeRow[] {
  const { snapshot } = usePortal();
  return useQuery(policyUpgradesQuery(snapshot?.workspace.tenantId)).data ?? [];
}

/** Each enabled repository whose saved rules still need moving into its policy file. */
export function usePolicyUpgrades(): PolicyUpgradeRow[] {
  return useUpgradeRows().filter((row) => row.upgrade !== undefined && row.upgrade.state !== "ok");
}

/** The repository's standing when there is something to say: saved rules to move, or why it could not be read. */
export function usePolicyUpgrade(repo: string): PolicyUpgradeRow | undefined {
  return useUpgradeRows().find((row) => row.repo === repo && (row.error !== undefined || row.upgrade?.state !== "ok"));
}

/** Opening the pull request, and keeping the file in place of the saved rules; either is followed by reading every view of the policy again. */
export function usePolicyUpgradeActions(repo: string, onSettled: () => void) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryClient = useQueryClient();

  function workspace(): string {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return tenantId;
  }

  async function reread() {
    await Promise.all(["policy-upgrades", "policy-file", "check-pack"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
    onSettled();
  }

  const propose = useMutation({
    mutationFn: function openPull() {
      return exportPolicyFile(createHubTransport(), workspace(), repo);
    },
    onSuccess: reread,
  });
  const keepFile = useMutation({
    mutationFn: function archiveSaved(savedId: string) {
      return archiveArtifact(createHubTransport(), workspace(), savedId);
    },
    onSuccess: reread,
  });
  return { propose, keepFile };
}
