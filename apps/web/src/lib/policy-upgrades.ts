import { queryOptions, skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { PolicyUpgrades, RepoSource } from "@corbits/triage-contracts";
import { exportPolicyFile, loadPolicyUpgrades, patchPolicyFile } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { POLICY_FILE_QUERY_KEY } from "./policy-file.ts";
import { usePortal } from "./portal.tsx";
import { sameRepo, type RepoId } from "./repo-id.ts";

export type PolicyUpgradeRow = PolicyUpgrades["repos"][number];

/**
 * `known`: each repository's last row with a standing, kept across rows that could not read it, which the next listing
 * is set against. `settled`: each repository whose policy file was merged while the portal was open.
 */
type Upgrades = { rows: PolicyUpgradeRow[]; known: PolicyUpgradeRow[]; settled: RepoId[] };

function starting(row: PolicyUpgradeRow): boolean {
  return row.upgrade?.state === "start";
}

function idOf(row: PolicyUpgradeRow): RepoId {
  return { name: row.repo, source: row.source };
}

export function rowFor(rows: readonly PolicyUpgradeRow[], repo: RepoId): PolicyUpgradeRow | undefined {
  return rows.find((row) => sameRepo(idOf(row), repo));
}

/** The repositories that had no policy file before and now have one. */
function newlySettled(before: readonly PolicyUpgradeRow[], now: readonly PolicyUpgradeRow[]): PolicyUpgradeRow[] {
  return before.filter((row) => starting(row) && rowFor(now, idOf(row))?.upgrade?.state === "ok");
}

/**
 * Where the hub could not list a repository's pull requests, the policy pull request last seen open is kept for its link,
 * unless the repository's standing moved meanwhile, as when the pull request adding its file merged.
 */
function withLastKnownPulls(before: readonly PolicyUpgradeRow[], now: readonly PolicyUpgradeRow[]): PolicyUpgradeRow[] {
  return now.map(function lastKnownPull(row) {
    const last = row.pullUnread ? rowFor(before, idOf(row)) : undefined;
    const moved = row.upgrade !== undefined && row.upgrade.state !== last?.upgrade?.state;
    return last?.pull && !moved ? { ...row, pull: last.pull } : row;
  });
}

/** The repositories whose policy pull request was listed before and is not now: merged or closed, so their file may differ. */
function pullsClosed(before: readonly PolicyUpgradeRow[], now: readonly PolicyUpgradeRow[]): PolicyUpgradeRow[] {
  return before.filter((row) => row.pull && rowFor(now, idOf(row))?.pull?.number !== row.pull.number);
}

const PULL_POLL_MS = 30_000;

export const POLICY_UPGRADES_QUERY_KEY = "policy-upgrades";

/**
 * The rows just listed, set against the last listing: a merge on the host gives a repository its file or changes it, and
 * a close leaves it as it was, so each such repository's policy is read again on its host.
 */
async function reconcile(queryClient: QueryClient, tenantId: string, before: Upgrades | undefined, listed: PolicyUpgradeRow[]): Promise<Upgrades> {
  const last = before?.known ?? [];
  const rows = withLastKnownPulls(last, listed);
  const settled = newlySettled(last, rows);
  const reread = [...new Set([...settled, ...pullsClosed(last, rows)])];
  await Promise.all(reread.flatMap((row) => [POLICY_FILE_QUERY_KEY, "check-pack"].map((key) => queryClient.invalidateQueries({ queryKey: [key, tenantId, row.repo, row.source] }))));
  const known = rows.map((row) => (row.upgrade ? row : rowFor(last, idOf(row)) ?? row));
  return { rows, known, settled: [...(before?.settled ?? []), ...settled.map(idOf)] };
}

function policyUpgradesQuery(tenantId: string | undefined, queryClient: QueryClient) {
  const queryKey = [POLICY_UPGRADES_QUERY_KEY, tenantId];
  const queryFn = tenantId === undefined ? skipToken : async function readPolicyUpgrades(): Promise<Upgrades> {
    const listed = await loadPolicyUpgrades(createHubTransport(), tenantId);
    return reconcile(queryClient, tenantId, queryClient.getQueryData<Upgrades>(queryKey), listed);
  };
  // A merge on the host changes a repository's standing without the portal knowing, so each load reads it again, and
  // while a policy pull request is open it is read again until it merges or closes.
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

/** Whether the repository's policy file was merged while the portal was open. */
export function useSettled(repo: RepoId): boolean {
  return useUpgrades()?.settled.some((done) => sameRepo(done, repo)) ?? false;
}

/** The repository's standing in a few words, wherever it is listed; undefined once it has a policy file. */
export function upgradeLabel(row: PolicyUpgradeRow): string | undefined {
  if (row.pull) return row.pullUnread ? "Couldn't check the policy pull request." : "Waiting for merge";
  return starting(row) ? "Add a policy file" : undefined;
}

/** Each enabled repository that still needs a policy file. */
export function usePolicyUpgrades(): PolicyUpgradeRow[] {
  return useUpgradeRows().filter(starting);
}

/** The repository's standing when there is something to say: a file to start, or why it could not be read. */
export function usePolicyUpgrade(repo: RepoId): PolicyUpgradeRow | undefined {
  const row = rowFor(useUpgradeRows(), repo);
  return row && (row.error !== undefined || starting(row)) ? row : undefined;
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
