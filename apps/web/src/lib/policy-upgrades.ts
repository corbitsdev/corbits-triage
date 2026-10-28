import { queryOptions, skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PolicyUpgrades, RepoSource } from "@corbits/triage-contracts";
import { exportPolicyFile, loadPolicyUpgrades, patchPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { POLICY_FILE_QUERY_KEY } from "./policy-file.ts";
import { usePortal } from "./portal.tsx";

export type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

/** `settled`: each repository whose policy file was merged while the portal was open. */
type Upgrades = { rows: PolicyUpgradeRow[]; settled: string[] };

function starting(row: PolicyUpgradeRow): boolean {
  return row.upgrade?.state === "start";
}

/** The repositories that had no policy file before and now have one. */
function newlySettled(before: readonly PolicyUpgradeRow[], now: readonly PolicyUpgradeRow[]): string[] {
  return before.filter((row) => starting(row) && now.some((next) => next.repo === row.repo && next.upgrade?.state === "ok")).map((row) => row.repo);
}

const PULL_POLL_MS = 30_000;

export const POLICY_UPGRADES_QUERY_KEY = "policy-upgrades";

function policyUpgradesQuery(tenantId: string | undefined, queryClient: QueryClient) {
  const queryKey = [POLICY_UPGRADES_QUERY_KEY, tenantId];
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyUpgrades(): Promise<Upgrades> {
    const rows = await loadPolicyUpgrades(createHubTransport(), tenantId);
    const before = queryClient.getQueryData<Upgrades>(queryKey);
    const settled = newlySettled(before?.rows ?? [], rows);
    // A merge on the host gives the repository its file, so its policy is read again.
    await Promise.all(settled.flatMap((repo) => [POLICY_FILE_QUERY_KEY, "check-pack"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId, repo] }))));
    return { rows, settled: [...(before?.settled ?? []), ...settled] };
  };
  // A merge on the host changes a repository's standing without the portal knowing, so each load reads it again, and
  // while the pull request adding its policy file is open it is read again until it merges.
  return queryOptions({
    queryKey,
    queryFn,
    staleTime: 60_000,
    refetchOnMount: "always",
    refetchInterval: (query) => (query.state.data?.rows.some((row) => starting(row) && row.pull) ? PULL_POLL_MS : false),
  });
}

function useUpgrades(): Upgrades | undefined {
  const { snapshot } = usePortal();
  return useQuery(policyUpgradesQuery(snapshot?.workspace.tenantId, useQueryClient())).data;
}

function useUpgradeRows(): PolicyUpgradeRow[] {
  return useUpgrades()?.rows ?? [];
}

/** Whether the repository's policy file was merged while the portal was open. */
export function useSettled(repo: string): boolean {
  return useUpgrades()?.settled.includes(repo) ?? false;
}

/** The repository's standing in a few words, wherever it is listed; undefined once it has a policy file. */
export function upgradeLabel(row: PolicyUpgradeRow): string | undefined {
  if (row.pull) return "Waiting for merge";
  return starting(row) ? "Add a policy file" : undefined;
}

/** Each enabled repository that still needs a policy file. */
export function usePolicyUpgrades(): PolicyUpgradeRow[] {
  return useUpgradeRows().filter(starting);
}

/** The repository's standing when there is something to say: a file to start, or why it could not be read. */
export function usePolicyUpgrade(repo: string): PolicyUpgradeRow | undefined {
  return useUpgradeRows().find((row) => row.repo === repo && (row.error !== undefined || starting(row)));
}

/** The workspace a policy write goes to, and reading every view of the policy again after one. */
function usePolicyWrites() {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const queryClient = useQueryClient();

  function workspace(): string {
    if (tenantId === undefined) throw new Error("The workspace is not known yet.");
    return tenantId;
  }

  async function reread() {
    await Promise.all([POLICY_UPGRADES_QUERY_KEY, POLICY_FILE_QUERY_KEY, "check-pack"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId] })));
  }

  return { workspace, reread };
}

/** Opening the pull request that adds the starter policy, and merging it; each is followed by reading every view of the policy again. */
export function usePolicyStartActions(repo: string, source: RepoSource) {
  const { writeGithub } = usePortal();
  const { workspace, reread } = usePolicyWrites();

  const propose = useMutation({
    mutationFn: function openPull() {
      return exportPolicyFile(createHubTransport(), workspace(), repo, source);
    },
    onSuccess: reread,
  });
  const merge = useMutation({
    mutationFn: function mergePull({ number, headSha }: { number: number; headSha: string }) {
      return writeGithub({ action: "merge", repo, number, headSha }, "now");
    },
    onSuccess: reread,
  });
  return { propose, merge };
}

/** Opening the policy pull request that removes what Triage skips in the file, then reading every view of the policy again. */
export function usePolicyStrip(repo: string, source: RepoSource) {
  const { workspace, reread } = usePolicyWrites();
  return useMutation({
    mutationFn: function stripReserved() {
      return patchPolicyFile(createHubTransport(), workspace(), repo, source, [{ kind: "strip-reserved" }]);
    },
    onSuccess: reread,
  });
}
