import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { toast } from "@corbits/react-ui/ui/toast";
import { toast as lastingToast } from "sonner";
import { useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { errorText } from "@corbits/common";
import { useSession } from "./session.tsx";
import { hubConfigured } from "./hub-origin.ts";
import { isTerminalRunEvents } from "@intx/hub-client";
import { ApiError, createHubTransport, createLeavingHubTransport } from "./hub-transport.ts";
import {
  configureGithubApp,
  configureGithubHook,
  createGrant,
  deleteGrant,
  ensureWorkspace,
  loadPortal,
  legacyHookCredentials,
  legacyGithubCredentials,
  connectedSources,
  portalConnected,
  replaceCredential,
  removeRepository,
  resolveApproval,
  revokeCredential,
  saveAnthropicKey,
  saveInference,
  setCodeReview,
  codeReviewSources,
  startBacklogTriage,
  githubPrAction,
  triagePullRequest as requestPullRequestTriage,
  untilDeploymentReady,
  WAITING_FOR_WORKFLOW,
  type HubGrant,
  type Inference,
  type InvitedAccess,
  type PrGithubWriteInput,
  type PrGithubWriteResult,
  type RunLog,
  type PortalSnapshot,
  type RepoRecord,
  type WorkspaceOption,
} from "./hub-api.ts";
import { readChosenWorkspace, writeChosenWorkspace } from "./chosen-workspace.ts";
import type { CreateGrantInput } from "./grant-actions.ts";
import { ensureWorkflows, releaseWorkflows, type DeployHosts } from "./workflow-deploy.ts";
import type { WorkflowKind } from "./workflow-packages.ts";
import { reconcileModelCatalog, removeAnthropicKey } from "./model-catalog.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackIndexQuery } from "./check-packs.ts";
import { hasDecisionModelCredential } from "./decision-models.ts";
import { syncGithubInstallations, type SyncResult } from "./github-manifest.ts";
import { checkPackName, type RepoSource } from "@corbits/triage-contracts";

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
  loadError: string;
  notify: (message: string) => void;
  warn: (message: string) => void;
  refresh: () => void;
  refreshNow: () => Promise<PortalSnapshot | null>;
  openWorkspace: (tenantId: string) => void;
  syncFromGithub: () => Promise<SyncResult>;
  configureApp: (secret: string) => Promise<void>;
  configureHook: (secret: string) => Promise<string>;
  removeRepo: (repo: string) => Promise<void>;
  runBacklog: (repo: string, message?: string) => Promise<void>;
  triagePullRequest: (repo: string, number: number) => Promise<void>;
  writeGithub: (input: PrGithubWriteInput, delivery: GithubDelivery) => Promise<PrGithubWriteResult>;
  decide: (approvalId: string, decision: "once" | "always" | "deny") => Promise<void>;
  replaceSecret: (credentialId: string, secret: string) => Promise<void>;
  revoke: (credentialId: string) => Promise<void>;
  addGrant: (input: CreateGrantInput) => Promise<void>;
  removeGrants: (grants: readonly HubGrant[]) => Promise<void>;
  saveInferenceSecret: (input: { endpoint: string; model: string; secret: string }) => Promise<void>;
  saveAnthropic: (secret: string) => Promise<void>;
  removeAnthropic: (credentialId: string) => Promise<void>;
  switchCodeReview: (repo: Pick<RepoRecord, "name" | "source">, enabled: boolean) => Promise<void>;
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
export const RUN_IDS_QUERY_KEY = "run-ids";
export const RUN_LOG_QUERY_KEY = "run-log";
export const TRIAGE_VERDICTS_QUERY_KEY = "triage-verdicts";
export const APPROVALS_QUERY_KEY = "approvals";
export const RUNS_QUERY_KEY = "runs";
export const GRANTS_QUERY_KEY = "grants";
export const PRINCIPALS_QUERY_KEY = "principals";
export const ROLES_QUERY_KEY = "roles";
export const DEPLOYED_WORKFLOWS_QUERY_KEY = "deployed-workflows";
export const ALLOWED_QUERY_KEY = "allowed";
export const INVITATIONS_QUERY_KEY = "invitations";
export const BITBUCKET_DATACENTER_QUERY_KEY = "bitbucket-datacenter";
export const INVITE_PATH = "/invite/";
const REFRESH_QUERY_KEYS = [
  [CHECK_PACK_INDEX_QUERY_KEY],
  PORTAL_QUERY_KEY,
  [RUN_IDS_QUERY_KEY],
  [RUN_LOG_QUERY_KEY],
  [TRIAGE_VERDICTS_QUERY_KEY],
  [APPROVALS_QUERY_KEY],
  [RUNS_QUERY_KEY],
  [GRANTS_QUERY_KEY],
  [PRINCIPALS_QUERY_KEY],
  [ROLES_QUERY_KEY],
  [DEPLOYED_WORKFLOWS_QUERY_KEY],
  [ALLOWED_QUERY_KEY],
  [INVITATIONS_QUERY_KEY],
  [BITBUCKET_DATACENTER_QUERY_KEY],
];

function isRunLog(value: unknown): value is RunLog {
  return typeof value === "object" && value !== null && "events" in value && Array.isArray(value.events);
}

export function isFinishedRunLogQuery(query: Query): boolean {
  return query.queryKey[0] === RUN_LOG_QUERY_KEY && isRunLog(query.state.data) && isTerminalRunEvents(query.state.data.events);
}

/** A refresh rereads everything except finished run logs. */
function canChange(query: Query): boolean {
  return !isFinishedRunLogQuery(query);
}

async function invalidateChangeable(queryClient: QueryClient, queryKeys: ReadonlyArray<readonly unknown[]>): Promise<void> {
  await Promise.all(queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey, predicate: canChange })));
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

/** Each tenant's converge, keyed by the hosts it was connected to, so connecting or disconnecting one converges again. */
const convergedTenants = new Set<string>();

const NO_HOSTS: DeployHosts = { connected: [], codeReview: [] };
const DEPLOY_MISSING: ReadonlySet<WorkflowKind> = new Set();
const REDEPLOY_TRIAGE: ReadonlySet<WorkflowKind> = new Set(["triage"]);
const REDEPLOY_CODE_REVIEW: ReadonlySet<WorkflowKind> = new Set(["code-review"]);

/** A workspace's converges are remembered per set of hosts; switching code review back on must deploy it again even when that set was seen before. */
function forgetConverged(tenantId: string): void {
  for (const key of convergedTenants) if (key.startsWith(`${tenantId}:`)) convergedTenants.delete(key);
}

function hostsOf(snapshot: PortalSnapshot): DeployHosts {
  return { connected: connectedSources(snapshot.credentials), codeReview: codeReviewSources(snapshot) };
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
      async function hasPack(repo: string) {
        return (await queryClient.fetchQuery(checkPackIndexQuery(tenantId))).has(checkPackName(repo));
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
  const readOnly = Boolean(enabled && !portalQuery.data && portalQuery.isError && !unauthorized);
  const loadError = readOnly ? errorText(portalQuery.error) : "";

  useEffect(function clearSnapshotWhenDisabled() {
    if (!enabled) {
      queryClient.removeQueries({ queryKey: PORTAL_QUERY_KEY });
    }
  }, [enabled, queryClient]);

  const tenantId = snapshot?.workspace.tenantId;
  const hosts = useMemo<DeployHosts>(() => (snapshot ? hostsOf(snapshot) : NO_HOSTS), [snapshot]);
  const decisionModelConnected = snapshot ? hasDecisionModelCredential(snapshot.credentials) : false;
  const inference = snapshot?.config?.inference;
  const convergeWorkflows = useCallback(function convergeWorkflows(id: string, deployHosts: DeployHosts, saved: Inference | undefined, redeploy: ReadonlySet<WorkflowKind>) {
    const key = `${id}:${JSON.stringify(deployHosts)}`;
    if (redeploy.size === 0 && convergedTenants.has(key)) return;
    convergedTenants.add(key);
    async function deploy() {
      try {
        const transport = createHubTransport();
        await reconcileModelCatalog(transport, id, saved);
        const deployed = await ensureWorkflows(transport, id, deployHosts, redeploy);
        if (deployed.length) refresh();
      } catch (cause: unknown) {
        convergedTenants.delete(key);
        warn(`Could not deploy triage workflows. ${errorText(cause)}`);
      }
    }
    void deploy();
  }, [refresh, warn]);

  useEffect(function convergeOnConnect() {
    if (tenantId && hosts.connected.length > 0 && decisionModelConnected) convergeWorkflows(tenantId, hosts, inference, DEPLOY_MISSING);
  }, [convergeWorkflows, decisionModelConnected, hosts, inference, tenantId]);

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
      const transport = createHubTransport();
      async function request() {
        return requestPullRequestTriage(transport, current.workspace.tenantId, repo, number);
      }
      await untilDeploymentReady(request, waitForWorkflow);
      await invalidateChangeable(queryClient, [[TRIAGE_VERDICTS_QUERY_KEY]]);
    },
    [queryClient, requireSnapshot, waitForWorkflow],
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

  const removeGrants = useCallback(
    async function removeGrants(grants: readonly HubGrant[]) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      try {
        for (const grant of grants) await deleteGrant(transport, current.workspace.tenantId, grant);
      } finally {
        refresh();
      }
      notify(grants.length === 1 ? "Access rule removed." : "Access rules removed.");
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
      const saved = await saveInference(createHubTransport(), current.workspace.tenantId, input);
      notify("Decision model saved.");
      refresh();
      const deployHosts = hostsOf(current);
      if (deployHosts.connected.length > 0) convergeWorkflows(current.workspace.tenantId, deployHosts, saved, REDEPLOY_TRIAGE);
    },
    [convergeWorkflows, notify, refresh, requireSnapshot],
  );

  const saveAnthropic = useCallback(
    async function saveAnthropic(secret: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await saveAnthropicKey(transport, current.workspace.tenantId, secret);
      await reconcileModelCatalog(transport, current.workspace.tenantId, current.config?.inference);
      notify("Anthropic key saved.");
      // A new key can mean new offerings, which a deployment resolves only when deployed.
      const fresh = await refreshNow();
      if (!fresh) return;
      const freshHosts = hostsOf(fresh);
      if (freshHosts.codeReview.length > 0) convergeWorkflows(fresh.workspace.tenantId, freshHosts, fresh.config?.inference, REDEPLOY_CODE_REVIEW);
    },
    [convergeWorkflows, notify, refreshNow, requireSnapshot],
  );

  const removeAnthropic = useCallback(
    async function removeAnthropic(credentialId: string) {
      const current = requireSnapshot();
      const transport = createHubTransport();
      await removeAnthropicKey(transport, current.workspace.tenantId, credentialId);
      await releaseWorkflows(transport, current.workspace.tenantId, "code-review");
      notify("Anthropic key removed.");
      refresh();
    },
    [notify, refresh, requireSnapshot],
  );

  const switchCodeReview = useCallback(
    async function switchCodeReview(repo: Pick<RepoRecord, "name" | "source">, enabled: boolean) {
      const current = requireSnapshot();
      await setCodeReview(createHubTransport(), current.workspace.tenantId, repo, enabled);
      notify(enabled ? `Code review is on for ${repo.name}.` : `Code review is off for ${repo.name}.`);
      // A host whose code review was off has no deployment, so the converge the fresh snapshot starts must deploy it.
      if (enabled && !hostsOf(current).codeReview.includes(repo.source)) forgetConverged(current.workspace.tenantId);
      await refreshNow();
    },
    [notify, refreshNow, requireSnapshot],
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
        loadError,
        notify,
        warn,
        refresh,
        refreshNow,
        openWorkspace,
        syncFromGithub,
        configureApp,
        configureHook,
        removeRepo,
        runBacklog,
        triagePullRequest,
        writeGithub,
        decide,
        replaceSecret,
        revoke,
        addGrant,
        removeGrants,
        saveInferenceSecret,
        saveAnthropic,
        removeAnthropic,
        switchCodeReview,
      };
    },
    [
      configured,
      loading,
      readOnly,
      snapshot,
      invitations,
      loadError,
      notify,
      warn,
      refresh,
      refreshNow,
      openWorkspace,
      syncFromGithub,
      configureApp,
      configureHook,
      removeRepo,
      runBacklog,
      triagePullRequest,
      writeGithub,
      decide,
      replaceSecret,
      revoke,
      addGrant,
      removeGrants,
      saveInferenceSecret,
      saveAnthropic,
      removeAnthropic,
      switchCodeReview,
    ],
  );

  return <PortalContext.Provider value={value}>{children}</PortalContext.Provider>;
}

export function usePortal(): PortalContextValue {
  const value = useContext(PortalContext);
  if (!value) throw new Error("Portal is unavailable.");
  return value;
}
