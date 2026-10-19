import { queryOptions, skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PolicyUpgrades } from "@corbits/triage-contracts";
import { archiveArtifact, exportPolicyFile, loadPolicyUpgrades } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { usePortal } from "./portal.tsx";

export type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

/** `settled`: each repository that came to run on its file, started or moved from saved rules, while the portal was open. */
type Upgrades = { rows: PolicyUpgradeRow[]; settled: string[] };

function unsettled(row: PolicyUpgradeRow): boolean {
  return row.upgrade !== undefined && row.upgrade.state !== "ok";
}

/** The repositories that had a file to start or saved rules to move before and now stand settled on their file. */
function newlySettled(before: readonly PolicyUpgradeRow[], now: readonly PolicyUpgradeRow[]): string[] {
  return before.filter((row) => unsettled(row) && now.some((next) => next.repo === row.repo && next.upgrade?.state === "ok")).map((row) => row.repo);
}

const PULL_POLL_MS = 30_000;

export const POLICY_UPGRADES_QUERY_KEY = "policy-upgrades";

function policyUpgradesQuery(tenantId: string | undefined, queryClient: QueryClient) {
  const queryKey = [POLICY_UPGRADES_QUERY_KEY, tenantId];
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyUpgrades(): Promise<Upgrades> {
    const rows = await loadPolicyUpgrades(createHubTransport(), tenantId);
    const before = queryClient.getQueryData<Upgrades>(queryKey);
    const settled = newlySettled(before?.rows ?? [], rows);
    // A merge on the host moves the repository onto its file, so its policy is read again.
    await Promise.all(settled.flatMap((repo) => ["policy-file", "check-pack", "repo-pack-session"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId, repo] }))));
    return { rows, settled: [...(before?.settled ?? []), ...settled] };
  };
  // A merge on the host changes a repository's standing without the portal knowing, so each load reads it again, and
  // while a pull request is open it is read again until it merges.
  return queryOptions({
    queryKey,
    queryFn,
    staleTime: 60_000,
    refetchOnMount: "always",
    refetchInterval: (query) => (query.state.data?.rows.some((row) => row.pull) ? PULL_POLL_MS : false),
  });
}

function useUpgrades(): Upgrades | undefined {
  const { snapshot } = usePortal();
  return useQuery(policyUpgradesQuery(snapshot?.workspace.tenantId, useQueryClient())).data;
}

function useUpgradeRows(): PolicyUpgradeRow[] {
  return useUpgrades()?.rows ?? [];
}

/** Whether the repository came to run on its file while the portal was open. */
export function useSettled(repo: string): boolean {
  return useUpgrades()?.settled.includes(repo) ?? false;
}

const UPGRADE_LABELS = { start: "Add a policy file", upgrade: "Move rules to a file", differs: "Rules differ from file" } as const;

/** The repository's standing in a few words, wherever it is listed; undefined once its rules come from its file. */
export function upgradeLabel(row: PolicyUpgradeRow): string | undefined {
  if (row.pull) return "Waiting for merge";
  if (row.upgrade?.state === "differs" && !row.upgrade.fixable && !row.upgrade.problem) return "Switch to the file";
  return row.upgrade && row.upgrade.state !== "ok" ? UPGRADE_LABELS[row.upgrade.state] : undefined;
}

/** Each enabled repository that still needs a policy file, or whose saved rules still need moving into it. */
export function usePolicyUpgrades(): PolicyUpgradeRow[] {
  return useUpgradeRows().filter(unsettled);
}

/** The repository's standing when there is something to say: a file to start, saved rules to move, or why it could not be read. */
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
    await Promise.all([POLICY_UPGRADES_QUERY_KEY, "policy-file", "check-pack"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
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
