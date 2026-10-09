import { toast } from "sonner";
import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "./session.tsx";
import { hubConfigured } from "./hub-origin.ts";
import { ApiError, createHubTransport } from "./hub-transport.ts";
import {
  configureGithubApp,
  hasActiveGithubCredential,
  configureGithubHook,
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
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackIndexQuery } from "./check-packs.ts";
import { hasDecisionModelCredential } from "./decision-models.ts";
import { syncGithubInstallations, type SyncResult } from "./github-manifest.ts";
import { checkPackName, type RepoPolicy } from "@corbits/triage-contracts";

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
  removeRepo: (repo: string) => Promise<void>;
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
  reply: "Replied on",
  labels: "Labeled",
  review: "Reviewed",
  merge: "Merged",
  close: "Closed",
};

export const PORTAL_QUERY_KEY = ["portal"] as const;
export const RUN_IDS_QUERY_KEY = "run-ids";
export const RUN_LOG_QUERY_KEY = "run-log";
export const APPROVALS_QUERY_KEY = "approvals";
export const RUNS_QUERY_KEY = "runs";
export const GRANTS_QUERY_KEY = "grants";
export const PRINCIPALS_QUERY_KEY = "principals";
export const ROLES_QUERY_KEY = "roles";
const REFRESH_QUERY_KEYS = [
  [CHECK_PACK_INDEX_QUERY_KEY],
  PORTAL_QUERY_KEY,
  [RUN_IDS_QUERY_KEY],
  [RUN_LOG_QUERY_KEY],
  [APPROVALS_QUERY_KEY],
  [RUNS_QUERY_KEY],
  [GRANTS_QUERY_KEY],
  [PRINCIPALS_QUERY_KEY],
  [ROLES_QUERY_KEY],
];

/** A 401 means the hub ended the session, so the local session is cleared too. */
export function useSignOutWhenRejected(): (cause: unknown) => void {
  const { signOut } = useSession();
  return useCallback(function signOutWhenRejected(cause: unknown) {
    async function signOutQuietly() {
      try {
        await signOut();
      } catch {
        // The hub already rejected the session; the local session clears either way.
      }
    }
    if (cause instanceof ApiError && cause.status === 401) void signOutQuietly();
  }, [signOut]);
}

const convergedTenants = new Set<string>();

export function PortalProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const signOutWhenRejected = useSignOutWhenRejected();
  const configured = hubConfigured();
  const queryClient = useQueryClient();
  const enabled = configured && Boolean(session);

  const loadSnapshot = useCallback(async function loadSnapshot() {
    const transport = createHubTransport();
    try {
      const workspace = await ensureWorkspace(transport);
      const tenantId = workspace.tenantId;
      async function hasPack(repo: string) {
        return (await queryClient.fetchQuery(checkPackIndexQuery(tenantId))).has(checkPackName(repo));
      }
      return await loadPortal(transport, workspace, hasPack);
    } catch (cause: unknown) {
      signOutWhenRejected(cause);
      throw cause;
    }
  }, [queryClient, signOutWhenRejected]);

  const refresh = useCallback(function refresh() {
    for (const queryKey of REFRESH_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey });
  }, [queryClient]);
  const refreshNow = useCallback(async function refreshNow() {
    await Promise.all(REFRESH_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
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
        removeRepo,
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
      removeRepo,
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
