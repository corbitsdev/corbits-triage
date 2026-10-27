import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "@corbits/react-ui/ui/toast";
import { toast as lastingToast } from "sonner";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { errorText } from "@corbits/common";
import { useSession } from "./session.tsx";
import { hubConfigured } from "./hub-origin.ts";
import { ApiError, createHubTransport, createLeavingHubTransport } from "./hub-transport.ts";
import {
  ANTHROPIC_PROVIDER,
  INFERENCE_PROVIDER,
  configureGithubHook,
  createGrant,
  ensureWorkspace,
  loadPortal,
  legacyHookCredentials,
  portalConnected,
  replaceCredential,
  removeRepository,
  resolveApproval,
  revokeCredential,
  saveAnthropicKey,
  startBacklogTriage,
  githubPrAction,
  triagePullRequest as requestPullRequestTriage,
  untilDeploymentReady,
  WAITING_FOR_WORKFLOW,
  type InvitedAccess,
  type PrGithubWriteInput,
  type PrGithubWriteResult,
  type PortalSnapshot,
  type RepoRecord,
  type WorkspaceOption,
} from "./hub-api.ts";
import { readChosenWorkspace, writeChosenWorkspace } from "./chosen-workspace.ts";
import type { CreateGrantInput } from "./grant-actions.ts";
import { reconcileModelCatalog, removeModelKey, saveInference } from "./model-catalog.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackIndexQuery } from "./check-packs.ts";
import { syncGithubInstallations, type SyncResult } from "./github-manifest.ts";
import { checkPackName } from "@corbits/triage-contracts";

/** `now` confirms the write with a toast; `held` writes were announced by the inbox's Undo toast; `leaving` ones are held writes sent as the page goes away, so they must outlive it. */
type GithubDelivery = "now" | "held" | "leaving";

interface PortalContextValue {
  configured: boolean;
  loading: boolean;
  readOnly: boolean;
  connected: boolean;
  snapshot: PortalSnapshot | null;
  /** Workspaces the user is invited to but not yet a member of, while they are a member of none. */
  invitations: WorkspaceOption[];
  /** The hub refuses this account until its address is verified. */
  unverified: boolean;
  loadError: string;
  notify: (message: string) => void;
  warn: (message: string) => void;
  refresh: () => void;
  refreshNow: () => Promise<PortalSnapshot | null>;
  openWorkspace: (tenantId: string) => void;
  syncFromGithub: () => Promise<SyncResult>;
  configureHook: (secret: string) => Promise<string>;
  removeRepo: (repo: string) => Promise<void>;
  runBacklog: (repo: string, message?: string) => Promise<void>;
  triagePullRequest: (repo: string, number: number) => Promise<void>;
  writeGithub: (input: PrGithubWriteInput, delivery: GithubDelivery) => Promise<PrGithubWriteResult>;
  decide: (approvalId: string, decision: "once" | "always" | "deny") => Promise<void>;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  saveInferenceSecret: (input: { endpoint: string; model: string; secret: string }) => Promise<void>;
  saveAnthropic: (secret: string) => Promise<void>;
  removeAnthropic: (credentialId: string) => Promise<void>;
  removeDecisionModel: (credentialId: string) => Promise<void>;
}

const NO_INVITATIONS: WorkspaceOption[] = [];
const WARNING_DURATION_MS = 8000;

const PortalContext = createContext<PortalContextValue | null>(null);

const GITHUB_ACTION_DONE: Record<PrGithubWriteInput["action"], string> = {
  comment: "Commented on",
  reply: "Replied on",
  labels: "Labeled",
  assign: "Assigned",
  "request-review": "Requested review on",
  review: "Reviewed",
  "code-review": "Sent the code review to",
  merge: "Merged",
  close: "Closed",
};

const PORTAL_QUERY_KEY = ["portal"] as const;
export const TRIAGE_VERDICTS_QUERY_KEY = "triage-verdicts";
export const APPROVALS_QUERY_KEY = "approvals";
export const PRINCIPALS_QUERY_KEY = "principals";
export const ROLES_QUERY_KEY = "roles";
export const DEPLOYED_WORKFLOWS_QUERY_KEY = "deployed-workflows";
export const ALLOWED_QUERY_KEY = "allowed";
export const INVITATIONS_QUERY_KEY = "invitations";
export const BITBUCKET_DATACENTER_QUERY_KEY = "bitbucket-datacenter";
export const TRIAGE_RELEASE_QUERY_KEY = "triage-release";
export const INVITE_PATH = "/invite/";
const REFRESH_QUERY_KEYS = [
  [CHECK_PACK_INDEX_QUERY_KEY],
  PORTAL_QUERY_KEY,
  [TRIAGE_VERDICTS_QUERY_KEY],
  [APPROVALS_QUERY_KEY],
  [PRINCIPALS_QUERY_KEY],
  [ROLES_QUERY_KEY],
  [DEPLOYED_WORKFLOWS_QUERY_KEY],
  [ALLOWED_QUERY_KEY],
  [INVITATIONS_QUERY_KEY],
  [BITBUCKET_DATACENTER_QUERY_KEY],
  [TRIAGE_RELEASE_QUERY_KEY],
];

async function invalidateChangeable(queryClient: QueryClient, queryKeys: ReadonlyArray<readonly unknown[]>): Promise<void> {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

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

type PortalLoad = PortalSnapshot | InvitedAccess;

function isInvited(load: PortalLoad): load is InvitedAccess {
  return "kind" in load;
}

function snapshotOf(load: PortalLoad | undefined): PortalSnapshot | null {
  return load && !isInvited(load) ? load : null;
}

export function PortalProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const signOutWhenRejected = useSignOutWhenRejected();
  const configured = hubConfigured();
  const queryClient = useQueryClient();
  // The invited workspace opens straight from the link, so the user is never given one of their own meanwhile.
  const acceptingInvite = useLocation().pathname.startsWith(INVITE_PATH);
  const enabled = configured && Boolean(session) && !acceptingInvite;
  const userId = session?.id;
  /** The workspace open in this tab, kept on every poll until the user switches. */
  const opened = useRef<{ userId: string; tenantId: string } | null>(null);

  const loadSnapshot = useCallback(async function loadSnapshot(): Promise<PortalLoad> {
    if (!userId) throw new Error("Sign in to open a workspace.");
    const transport = createHubTransport();
    try {
      const current = opened.current?.userId === userId ? opened.current.tenantId : readChosenWorkspace(userId);
      const access = await ensureWorkspace(transport, current);
      if (access.kind === "invited") return access;
      const tenantId = access.workspace.tenantId;
      opened.current = { userId, tenantId };
      async function hasPack(record: RepoRecord) {
        return (await queryClient.fetchQuery(checkPackIndexQuery(tenantId))).has(checkPackName(record.name, record.source));
      }
      return await loadPortal(transport, access, hasPack);
    } catch (cause: unknown) {
      signOutWhenRejected(cause);
      throw cause;
    }
  }, [queryClient, signOutWhenRejected, userId]);

  const refresh = useCallback(function refresh() {
    void invalidateChangeable(queryClient, REFRESH_QUERY_KEYS);
  }, [queryClient]);
  const refreshNow = useCallback(async function refreshNow() {
    await invalidateChangeable(queryClient, REFRESH_QUERY_KEYS);
    return snapshotOf(await queryClient.fetchQuery({
      queryKey: PORTAL_QUERY_KEY,
      queryFn: loadSnapshot,
    }));
  }, [loadSnapshot, queryClient]);
  const openWorkspace = useCallback(function openWorkspace(tenantId: string) {
    if (!userId) throw new Error("Sign in to open a workspace.");
    opened.current = { userId, tenantId };
    writeChosenWorkspace(userId, tenantId);
    void queryClient.resetQueries({ queryKey: PORTAL_QUERY_KEY });
  }, [queryClient, userId]);
  const notify = useCallback(function notify(message: string) {
    toast(message);
  }, []);
  const warn = useCallback(function warn(message: string) {
    // react-ui's toast fixes a short confirmation duration; sonner renders this one under the same Toaster.
    lastingToast(message, { duration: WARNING_DURATION_MS });
  }, []);

  const portalQuery = useQuery({
    queryKey: PORTAL_QUERY_KEY,
    enabled,
    refetchOnWindowFocus: true,
    refetchInterval: 10_000,
    retry: false,
    queryFn: loadSnapshot,
  });

  const snapshot = enabled ? snapshotOf(portalQuery.data) : null;
  const invitations = enabled && portalQuery.data && isInvited(portalQuery.data) ? portalQuery.data.invitations : NO_INVITATIONS;
  const loading = enabled && portalQuery.isPending;
  const unauthorized = portalQuery.error instanceof ApiError && portalQuery.error.status === 401;
  const unverified = enabled && portalQuery.error instanceof ApiError && portalQuery.error.code === "email_unverified";
  const readOnly = Boolean(enabled && !portalQuery.data && portalQuery.isError && !unauthorized && !unverified);
  const loadError = readOnly ? errorText(portalQuery.error) : "";

  useEffect(function clearSnapshotWhenDisabled() {
    if (!enabled) {
      queryClient.removeQueries({ queryKey: PORTAL_QUERY_KEY });
    }
  }, [enabled, queryClient]);

  const requireSnapshot = useCallback(function requireSnapshot() {
    if (readOnly || !snapshot) {
      throw new Error("The service is unavailable. Reload the page and try again.");
    }
    return snapshot;
  }, [readOnly, snapshot]);

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

  const waitForWorkflow = useCallback(function waitForWorkflow() {
    notify(WAITING_FOR_WORKFLOW);
  }, [notify]);

  const runBacklog = useCallback(
    async function runBacklog(repo: string, message = "Backlog triage started.") {
      const current = requireSnapshot();
      const transport = createHubTransport();
      async function start() {
        return startBacklogTriage(transport, current.workspace.tenantId, repo);
      }
      await untilDeploymentReady(start, waitForWorkflow);
      notify(message);
      refresh();
    },
    [notify, refresh, requireSnapshot, waitForWorkflow],
  );

  const triagePullRequest = useCallback(
    async function triagePullRequest(repo: string, number: number) {
      const current = requireSnapshot();
      await requestPullRequestTriage(createHubTransport(), current.workspace.tenantId, repo, number);
      await invalidateChangeable(queryClient, [[TRIAGE_VERDICTS_QUERY_KEY]]);
    },
    [queryClient, requireSnapshot],
  );

  const writeGithub = useCallback(
    async function writeGithub(input: PrGithubWriteInput, delivery: GithubDelivery) {
      const current = requireSnapshot();
      const transport = delivery === "leaving" ? createLeavingHubTransport() : createHubTransport();
      const result = await githubPrAction(transport, current.workspace.tenantId, input);
      if (delivery === "now" && result.alreadySent) notify(`The code review was already on ${input.repo}#${input.number}.`);
      else if (delivery === "now") notify(`${GITHUB_ACTION_DONE[input.action]} ${input.repo}#${input.number}.`);
      refresh();
      return result;
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

  /** So returning from GitHub never waits on a webhook. */
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
      await reconcileModelCatalog(createHubTransport(), current.workspace.tenantId);
      await invalidateChangeable(queryClient, REFRESH_QUERY_KEYS);
      notify("Decision model saved.");
    },
    [notify, queryClient, requireSnapshot],
  );

  const saveAnthropic = useCallback(
    async function saveAnthropic(secret: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await saveAnthropicKey(transport, current.workspace.tenantId, secret);
      await reconcileModelCatalog(transport, current.workspace.tenantId);
      await invalidateChangeable(queryClient, REFRESH_QUERY_KEYS);
      notify("Anthropic key saved.");
    },
    [notify, queryClient, requireSnapshot],
  );

  const removeAnthropic = useCallback(
    async function removeAnthropic(credentialId: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await removeModelKey(transport, current.workspace.tenantId, ANTHROPIC_PROVIDER, credentialId);
      notify("Anthropic key removed.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const removeDecisionModel = useCallback(
    async function removeDecisionModel(credentialId: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await removeModelKey(transport, current.workspace.tenantId, INFERENCE_PROVIDER, credentialId);
      notify("Decision model removed.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const value = useMemo<PortalContextValue>(
    function portalValue() {
      return {
        configured,
        loading,
        readOnly,
        connected: snapshot ? portalConnected(snapshot) : false,
        snapshot,
        invitations,
        unverified,
        loadError,
        notify,
        warn,
        refresh,
        refreshNow,
        openWorkspace,
        syncFromGithub,
        configureHook,
        removeRepo,
        runBacklog,
        triagePullRequest,
        writeGithub,
        decide,
        replaceSecret,
        revoke,
        addGrant,
        saveInferenceSecret,
        saveAnthropic,
        removeAnthropic,
        removeDecisionModel,
      };
    },
    [
      configured,
      loading,
      readOnly,
      snapshot,
      invitations,
      unverified,
      loadError,
      notify,
      warn,
      refresh,
      refreshNow,
      openWorkspace,
      syncFromGithub,
      configureHook,
      removeRepo,
      runBacklog,
      triagePullRequest,
      writeGithub,
      decide,
      replaceSecret,
      revoke,
      addGrant,
      saveInferenceSecret,
      saveAnthropic,
      removeAnthropic,
      removeDecisionModel,
    ],
  );

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext);
  if (!value) throw new Error("Portal is unavailable.");
  return value;
}
