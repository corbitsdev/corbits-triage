import { toast } from "sonner";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session.tsx";
import { hubConfigured } from "./hub-origin.ts";
import { ApiError, createHubTransport } from "./hub-transport.ts";
import {
  changeRepository,
  configureGithubApp,
  hasActiveGithubCredential,
  configureGithubHook,
  connectRepository,
  createGrant,
  deleteGrant,
  ensureWorkspace,
  loadPortal,
  legacyHookCredentials,
  legacyGithubCredentials,
  portalConnected,
  replaceCredential,
  removeRepository,
  resolveApproval,
  revokeCredential,
  saveInference,
  saveSettings,
  saveRepoPolicy,
  startBacklogTriage,
  githubPrAction,
  startPullRequestTriage,
  type HubGrant,
  type PrGithubWriteInput,
  type PrItem,
  type PortalSnapshot,
} from "./hub-api.ts";
import type { CreateGrantInput } from "./grant-actions.ts";
import { ensureWorkflows, suggestOfferings } from "./workflow-deploy.ts";
import { hasDecisionModelCredential } from "./decision-models.ts";
import { syncGithubInstallations, type SyncResult } from "./github-manifest.ts";
import type { RepoPolicy } from "@corbits/triage-contracts";

interface PortalContextValue {
  configured: boolean;
  loading: boolean;
  readOnly: boolean;
  connected: boolean;
  snapshot: PortalSnapshot | null;
  loadError: string;
  notify: (message: string) => void;
  refresh: () => void;
  refreshNow: () => Promise<PortalSnapshot | null>;
  syncFromGithub: () => Promise<SyncResult>;
  configureApp: (secret: string) => Promise<void>;
  configureHook: (secret: string) => Promise<string>;
  connect: (repo: string) => Promise<void>;
  removeRepo: (repo: string) => Promise<void>;
  changeRepo: (previousRepo: string, repo: string) => Promise<void>;
  runBacklog: (repo: string, message?: string) => Promise<void>;
  runPullRequest: (pullRequest: string, refreshAfter?: boolean) => Promise<void>;
  closeDuplicate: (item: PrItem) => Promise<void>;
  writeGithub: (input: PrGithubWriteInput) => Promise<void>;
  decide: (approvalId: string, decision: "once" | "always" | "deny") => Promise<void>;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  removeGrant: (grant: HubGrant) => Promise<void>;
  saveConfig: (patch: Parameters<typeof saveSettings>[2]) => Promise<void>;
  saveRepoPolicy: (repo: string, policy: RepoPolicy) => Promise<void>;
  saveInferenceSecret: (input: { endpoint: string; model: string; secret: string }) => Promise<void>;
}

const PortalContext = createContext<PortalContextValue | null>(null);

const GITHUB_ACTION_DONE: Record<PrGithubWriteInput["action"], string> = {
  comment: "Commented on",
  labels: "Labeled",
  review: "Reviewed",
  merge: "Merged",
  close: "Closed",
};

export const PORTAL_QUERY_KEY = ["portal"] as const;

const convergedTenants = new Set<string>();

export function PortalProvider({ children }: { children: ReactNode }) {
  const { session, signOut } = useSession();
  const configured = hubConfigured();
  const queryClient = useQueryClient();
  const enabled = configured && Boolean(session);

  const loadSnapshot = useCallback(async function loadSnapshot() {
    async function signOutQuietly() {
      try {
        await signOut();
      } catch {
        // The hub already rejected the session; the local session clears either way.
      }
    }

    const transport = createHubTransport();
    try {
      const workspace = await ensureWorkspace(transport);
      return loadPortal(transport, workspace);
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.status === 401) {
        void signOutQuietly();
      }
      throw cause;
    }
  }, [signOut]);

  const refresh = useCallback(function refresh() {
    void queryClient.invalidateQueries({ queryKey: PORTAL_QUERY_KEY });
  }, [queryClient]);
  const refreshNow = useCallback(async function refreshNow() {
    await queryClient.invalidateQueries({ queryKey: PORTAL_QUERY_KEY });
    return queryClient.fetchQuery({
      queryKey: PORTAL_QUERY_KEY,
      queryFn: loadSnapshot,
    });
  }, [loadSnapshot, queryClient]);
  const notify = useCallback(function notify(message: string) {
    toast(message);
  }, []);

  const portalQuery = useQuery({
    queryKey: PORTAL_QUERY_KEY,
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
    retry: false,
    queryFn: loadSnapshot,
  });

  const snapshot = enabled ? portalQuery.data ?? null : null;
  const loading = enabled && portalQuery.isPending;
  const unauthorized = portalQuery.error instanceof ApiError && portalQuery.error.status === 401;
  const loadError = enabled && !snapshot && portalQuery.isError && !unauthorized
    ? (portalQuery.error instanceof Error ? portalQuery.error.message : String(portalQuery.error))
    : "";
  const readOnly = Boolean(enabled && !snapshot && portalQuery.isError && !unauthorized);

  useEffect(function clearSnapshotWhenDisabled() {
    if (!enabled) {
      queryClient.removeQueries({ queryKey: PORTAL_QUERY_KEY });
    }
  }, [enabled, queryClient]);

  const tenantId = snapshot?.workspace.tenantId;
  const githubConnected = snapshot ? hasActiveGithubCredential(snapshot.credentials) : false;
  const decisionModelConnected = snapshot ? hasDecisionModelCredential(snapshot.credentials) : false;
  const convergeWorkflows = useCallback(function convergeWorkflows(id: string, redeploy: boolean) {
    if (!redeploy && convergedTenants.has(id)) return;
    convergedTenants.add(id);
    async function deploy() {
      try {
        const transport = createHubTransport();
        const offerings = await suggestOfferings(transport, id);
        if (!offerings) throw new Error("No decision model offering found. Save it again in Settings → Model.");
        const deployed = await ensureWorkflows(transport, id, offerings, redeploy);
        if (deployed.length) refresh();
      } catch (cause: unknown) {
        convergedTenants.delete(id);
        notify(`Could not deploy triage workflows. ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    void deploy();
  }, [notify, refresh]);

  useEffect(function convergeOnConnect() {
    if (tenantId && githubConnected && decisionModelConnected) convergeWorkflows(tenantId, false);
  }, [convergeWorkflows, decisionModelConnected, githubConnected, tenantId]);

  const requireSnapshot = useCallback(function requireSnapshot() {
    if (readOnly || !snapshot) {
      throw new Error("The service is unavailable. Reload the page and try again.");
    }
    return snapshot;
  }, [readOnly, snapshot]);

  const configureApp = useCallback(
    async function configureApp(secret: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await configureGithubApp(
        transport,
        current.workspace.tenantId,
        secret,
        legacyGithubCredentials(current.credentials).map((row) => row.id),
      );
      notify("GitHub App saved.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const connect = useCallback(
    async function connect(repo: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await connectRepository(transport, current.workspace.tenantId, { repo });
      notify(`Backlog triage started for ${repo}.`);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const configureHook = useCallback(
    async function configureHook(secret: string) {
      const current = requireSnapshot();
      const id = await configureGithubHook(
        createHubTransport(),
        current.workspace.tenantId,
        secret,
        legacyHookCredentials(current.credentials).map((row) => row.id),
      );
      notify("GitHub App webhook saved.");
      refresh();
      return id;
    },
    [notify, refresh, requireSnapshot],
  );

  const removeRepo = useCallback(
    async function removeRepo(repo: string) {
      const current = requireSnapshot();
      await removeRepository(createHubTransport(), current.workspace.tenantId, repo);
      notify(`Removed ${repo}.`);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const changeRepo = useCallback(
    async function changeRepo(previousRepo: string, repo: string) {
      const current = requireSnapshot();
      await changeRepository(createHubTransport(), current.workspace.tenantId, {
        previousRepo,
        repo,
      });
      notify(`Changed ${previousRepo} to ${repo} and started backlog triage.`);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const runBacklog = useCallback(
    async function runBacklog(repo: string, message = "Backlog triage started.") {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await startBacklogTriage(transport, current.workspace.tenantId, repo);
      notify(message);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const runPullRequest = useCallback(
    async function runPullRequest(pullRequest: string, refreshAfter = true) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await startPullRequestTriage(transport, current.workspace.tenantId, pullRequest);
      notify(`Pull request triage started for ${pullRequest}.`);
      if (refreshAfter) refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const closeDuplicate = useCallback(
    async function closeDuplicate(item: PrItem) {
      const current = requireSnapshot();
      if (!item.canClose || item.number === null || item.comment === null) throw new Error("Only a confirmed duplicate can be closed.");
      await githubPrAction(createHubTransport(), current.workspace.tenantId, {
        action: "close",
        repo: item.repo,
        number: item.number,
        labels: item.labels,
        comment: item.comment,
      });
      notify(`Closed ${item.key} as a duplicate.`);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const writeGithub = useCallback(
    async function writeGithub(input: PrGithubWriteInput) {
      const current = requireSnapshot();
      await githubPrAction(createHubTransport(), current.workspace.tenantId, input);
      notify(`${GITHUB_ACTION_DONE[input.action]} ${input.repo}#${input.number}.`);
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const decide = useCallback(
    async function decide(approvalId: string, decision: "once" | "always" | "deny") {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await resolveApproval(transport, current.workspace.tenantId, approvalId, decision);
      notify(decision === "deny" ? "Request rejected." : "Request approved.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const replaceSecret = useCallback(
    async function replaceSecret(credentialId: string, secret: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await replaceCredential(transport, current.workspace.tenantId, credentialId, secret);
      notify("Secret updated.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const revoke = useCallback(
    async function revoke(credentialId: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await revokeCredential(transport, current.workspace.tenantId, credentialId);
      notify("Secret removed.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const addGrant = useCallback(
    async function addGrant(input: CreateGrantInput) {
      const current = requireSnapshot();
      await createGrant(createHubTransport(), current.workspace.tenantId, input);
      notify("Access rule added.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const removeGrant = useCallback(
    async function removeGrant(grant: HubGrant) {
      const current = requireSnapshot();
      await deleteGrant(createHubTransport(), current.workspace.tenantId, grant);
      notify("Access rule removed.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const saveConfig = useCallback(
    async function saveConfig(patch: Parameters<typeof saveSettings>[2]) {
      const current = requireSnapshot();
      await saveSettings(createHubTransport(), current.workspace.tenantId, patch);
      notify("Settings saved.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const saveRepo = useCallback(
    async function saveRepo(repo: string, policy: RepoPolicy) {
      const current = requireSnapshot();
      await saveRepoPolicy(createHubTransport(), current.workspace.tenantId, repo, policy);
      refresh();
    },
    [refresh, requireSnapshot],
  );

  /** Reads the App's repositories from GitHub, so returning from GitHub never waits on a webhook. */
  const syncFromGithub = useCallback(async function syncFromGithub() {
    const current = requireSnapshot();
    const result = await syncGithubInstallations(current.workspace.tenantId);
    await refreshNow();
    return result;
  }, [refreshNow, requireSnapshot]);

  const saveInferenceSecret = useCallback(
    async function saveInferenceSecret(input: { endpoint: string; model: string; secret: string }) {
      const current = requireSnapshot();
      await saveInference(createHubTransport(), current.workspace.tenantId, input);
      notify("Decision model saved.");
      refresh();
      if (hasActiveGithubCredential(current.credentials)) convergeWorkflows(current.workspace.tenantId, true);
    },
    [convergeWorkflows, notify, refresh, requireSnapshot],
  );

  const value = useMemo<PortalContextValue>(
    function portalValue() {
      return {
        configured,
        loading,
        readOnly,
        connected: snapshot ? portalConnected(snapshot) : false,
        snapshot,
        loadError,
        notify,
        refresh,
        refreshNow,
        syncFromGithub,
        configureApp,
        configureHook,
        connect,
        removeRepo,
        changeRepo,
        runBacklog,
        runPullRequest,
        closeDuplicate,
        writeGithub,
        decide,
        replaceSecret,
        revoke,
        addGrant,
        removeGrant,
        saveConfig,
        saveRepoPolicy: saveRepo,
        saveInferenceSecret,
      };
    },
    [
      configured,
      loading,
      readOnly,
      snapshot,
      loadError,
      notify,
      refresh,
      refreshNow,
      syncFromGithub,
      configureApp,
      configureHook,
      connect,
      removeRepo,
      changeRepo,
      runBacklog,
      runPullRequest,
      closeDuplicate,
      writeGithub,
      decide,
      replaceSecret,
      revoke,
      addGrant,
      removeGrant,
      saveConfig,
      saveRepo,
      saveInferenceSecret,
    ],
  );

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext);
  if (!value) throw new Error("Portal is unavailable.");
  return value;
}
