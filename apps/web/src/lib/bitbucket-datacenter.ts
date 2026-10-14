import { useMemo } from "react";
import { skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  connectBitbucketDatacenter,
  disableBitbucketDatacenterRepository,
  disconnectBitbucketDatacenter,
  enableBitbucketDatacenterRepository,
  listBitbucketDatacenterRepositories,
  loadBitbucketDatacenterConnection,
  type BitbucketDatacenterEnabled,
  type RepoRecord,
} from "./hub-api.ts";
import { createHubTransport, type Transport } from "./hub-transport.ts";
import { BITBUCKET_DATACENTER_QUERY_KEY, usePortal } from "./portal.tsx";

function connectionKey(tenantId: string | undefined) {
  return [BITBUCKET_DATACENTER_QUERY_KEY, tenantId, "connection"] as const;
}

function repositoriesKey(tenantId: string | undefined) {
  return [BITBUCKET_DATACENTER_QUERY_KEY, tenantId, "repositories"] as const;
}

/** `data` is null when the workspace has no Bitbucket Data Center connection. */
export function useBitbucketDatacenterConnection() {
  const tenantId = usePortal().snapshot?.workspace.tenantId;
  return useQuery({
    queryKey: connectionKey(tenantId),
    queryFn: tenantId === undefined ? skipToken : async function loadConnection() {
      return loadBitbucketDatacenterConnection(createHubTransport(), tenantId);
    },
  });
}

/** Every repository the connection's token sees, with the stored records merged in. */
export function useBitbucketDatacenterRepositories() {
  const tenantId = usePortal().snapshot?.workspace.tenantId;
  const connected = Boolean(useBitbucketDatacenterConnection().data);
  return useQuery({
    queryKey: repositoriesKey(tenantId),
    queryFn: tenantId === undefined || !connected ? skipToken : async function listRepositories() {
      return listBitbucketDatacenterRepositories(createHubTransport(), tenantId);
    },
  });
}

/** The stored repositories, then the Bitbucket Data Center repositories not recorded yet. */
export function mergeRepositories(stored: RepoRecord[], listed: RepoRecord[] | undefined): RepoRecord[] {
  const names = new Set(stored.map((repo) => repo.name));
  return [...stored, ...(listed ?? []).filter((repo) => !names.has(repo.name))];
}

/** `pending` until the Bitbucket Data Center repositories are known, or known to be none. */
export function useRepositories(): { repos: RepoRecord[]; pending: boolean } {
  const { snapshot } = usePortal();
  const connection = useBitbucketDatacenterConnection();
  const listing = useBitbucketDatacenterRepositories();
  const repos = useMemo(() => mergeRepositories(snapshot?.repos ?? [], listing.data), [snapshot?.repos, listing.data]);
  return { repos, pending: connection.isPending || listing.isLoading };
}

function requireTenant(tenantId: string | undefined): string {
  if (tenantId === undefined) throw new Error("Open a workspace first.");
  return tenantId;
}

/** Connecting may be what lets the workspace in, so the portal reads its credentials again. */
export function useConnectBitbucketDatacenter() {
  const queryClient = useQueryClient();
  const { snapshot, refreshNow } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: async function connect(input: { baseUrl: string; token: string }) {
      return connectBitbucketDatacenter(createHubTransport(), requireTenant(tenantId), input);
    },
    onSuccess: async function storeConnection({ baseUrl, hookUrl }) {
      queryClient.setQueryData(connectionKey(tenantId), { baseUrl, hookUrl });
      await queryClient.invalidateQueries({ queryKey: repositoriesKey(tenantId) });
      await refreshNow();
    },
  });
}

/** Disconnecting disables every Bitbucket Data Center repository, so the stored repositories are read again. */
export function useDisconnectBitbucketDatacenter() {
  const queryClient = useQueryClient();
  const { snapshot, refreshNow } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: async function disconnect() {
      return disconnectBitbucketDatacenter(createHubTransport(), requireTenant(tenantId));
    },
    onSuccess: async function forgetConnection() {
      queryClient.setQueryData(connectionKey(tenantId), null);
      queryClient.removeQueries({ queryKey: repositoriesKey(tenantId) });
      await refreshNow();
    },
  });
}

/** Whether the Bitbucket Data Center listing names `repo`; it lists the recorded repositories too. */
export function isBitbucketDatacenterRepo(queryClient: QueryClient, tenantId: string, repo: string): boolean {
  const listed = queryClient.getQueryData<RepoRecord[]>(repositoriesKey(tenantId));
  return listed?.some((row) => row.name === repo) === true;
}

function webhookKey(tenantId: string | undefined, repo: string) {
  return [BITBUCKET_DATACENTER_QUERY_KEY, tenantId, "webhook", repo] as const;
}

/** Turning triage on or off also creates or removes the webhook, which only the hub's routes do; a webhook the token may not create is kept for the panel to show. */
export async function switchBitbucketDatacenterTriage(queryClient: QueryClient, transport: Transport, tenantId: string, repo: string, enabled: boolean): Promise<void> {
  if (!enabled) {
    await disableBitbucketDatacenterRepository(transport, tenantId, repo);
    queryClient.removeQueries({ queryKey: webhookKey(tenantId, repo) });
    return;
  }
  const result = await enableBitbucketDatacenterRepository(transport, tenantId, repo);
  if (result.webhook === "manual") queryClient.setQueryData(webhookKey(tenantId, repo), result);
}

/** The webhook to set up by hand after triage was turned on with a token that may not manage webhooks. */
export function useBitbucketDatacenterManualWebhook(repo: string) {
  const tenantId = usePortal().snapshot?.workspace.tenantId;
  return useQuery<Extract<BitbucketDatacenterEnabled, { webhook: "manual" }>>({ queryKey: webhookKey(tenantId, repo), queryFn: skipToken }).data;
}

export function bitbucketDatacenterRepoUrl(baseUrl: string, repo: string): string {
  const [project, slug] = repo.split("/");
  return `${baseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(project!)}/repos/${encodeURIComponent(slug!)}`;
}
