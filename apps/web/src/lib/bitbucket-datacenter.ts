import { useMemo } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  connectBitbucketDatacenter,
  disableBitbucketDatacenterRepository,
  disconnectBitbucketDatacenter,
  enableBitbucketDatacenterRepository,
  listBitbucketDatacenterRepositories,
  loadBitbucketDatacenterConnection,
  type RepoRecord,
} from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
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

export function useRepositories(): RepoRecord[] {
  const { snapshot } = usePortal();
  const listed = useBitbucketDatacenterRepositories().data;
  return useMemo(() => mergeRepositories(snapshot?.repos ?? [], listed), [snapshot?.repos, listed]);
}

function requireTenant(tenantId: string | undefined): string {
  if (tenantId === undefined) throw new Error("Open a workspace first.");
  return tenantId;
}

export function useConnectBitbucketDatacenter() {
  const queryClient = useQueryClient();
  const tenantId = usePortal().snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: async function connect(input: { baseUrl: string; token: string }) {
      return connectBitbucketDatacenter(createHubTransport(), requireTenant(tenantId), input);
    },
    onSuccess: async function storeConnection({ baseUrl, hookUrl }) {
      queryClient.setQueryData(connectionKey(tenantId), { baseUrl, hookUrl });
      await queryClient.invalidateQueries({ queryKey: repositoriesKey(tenantId) });
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

type Toggle = { repo: string; enabled: boolean };

/** Turning triage on or off also creates or removes the repository's webhook, which only the hub's routes do. */
export function useToggleBitbucketDatacenterRepository() {
  const queryClient = useQueryClient();
  const { snapshot, refreshNow } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useMutation({
    mutationFn: async function toggle({ repo, enabled }: Toggle) {
      const transport = createHubTransport();
      const tenant = requireTenant(tenantId);
      if (enabled) return enableBitbucketDatacenterRepository(transport, tenant, repo);
      return disableBitbucketDatacenterRepository(transport, tenant, repo);
    },
    onSuccess: async function readStoredAgain() {
      await queryClient.invalidateQueries({ queryKey: repositoriesKey(tenantId) });
      await refreshNow();
    },
  });
}

export function bitbucketDatacenterRepoUrl(baseUrl: string, repo: string): string {
  const [project, slug] = repo.split("/");
  return `${baseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(project!)}/repos/${encodeURIComponent(slug!)}`;
}
