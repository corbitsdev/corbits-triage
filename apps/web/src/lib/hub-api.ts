import {
  ApiError,
  listWorkflowDeployments,
  readWorkflowRunEvents,
  triggerWorkflowRun,
  type Transport,
  type WorkflowRunEvent,
} from "@intx/hub-client";
import type { ApprovalResponse, CredentialResponse, GrantResponse, PrincipalResponse, RoleResponse, WorkflowRunResponse } from "@intx/types";
import { repoPolicy, readCheckPack, checkPackName, parseCheckOutput, ACTION_KINDS, RETIRED_CHECK_IDS, DeployedVersions, InviteRoles, InviteSent, SessionList, TriageStats, TriageVerdicts, type ActionKind, type AuthorKind, type CheckOutput, type CheckPack, type RepoCheckFlags, type RepoPolicy, type RepoRole, type TriageEvent, type VerdictDetail } from "@corbits/triage-contracts";
import { assertCanRemoveGrant, createGrantBody, type CreateGrantInput } from "./grant-actions.ts";

export const WORKSPACE_SLUG =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_WORKSPACE_SLUG?.trim() || "corbits-triage";
export const BACKLOG_WORKFLOW = "pr-triage-historical";
export const GITHUB_PROVIDER = "github";
export const GITHUB_PROVIDER_PLUGIN = "http";
export const GITHUB_CREDENTIAL_NAME = "github";
export const GITHUB_HOOK_CREDENTIAL_NAME = "github-hook";
export const INFERENCE_PROVIDER = "corbits-system-one";
export const INFERENCE_PROVIDER_PLUGIN = "corbits-system-one";
export const INFERENCE_CREDENTIAL_NAME = "corbits-system-one";
/** Catalog model the triage workflows declare; its offering carries the provider's own model name. */
export const DECISION_MODEL_ALIAS = "decision";

export function githubProviderApiBaseUrl(
  env: Record<string, string | undefined> = (import.meta as { env?: Record<string, string | undefined> }).env ?? {},
): string {
  const raw = env["VITE_GITHUB_API_ORIGIN"]?.trim();
  if (!raw) return "https://api.github.com";
  return raw.replace(/\/+$/, "");
}

export type Workspace = {
  tenantId: string;
  principalId: string;
  userId: string;
};

/** Stock PrincipalSummary, as /api/me/principals returns it, newest principal first. */
export type Membership = {
  principalId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  kind: "user" | "agent";
  status: "active" | "suspended" | "invited" | "deactivated";
  roles: Array<{ id: string; name: string }>;
};

export type WorkspaceOption = { tenantId: string; name: string; slug: string };

export type MemberAccess = { kind: "member"; workspace: Workspace; workspaces: WorkspaceOption[]; invitations: WorkspaceOption[] };
export type InvitedAccess = { kind: "invited"; invitations: WorkspaceOption[] };
export type WorkspaceAccess = MemberAccess | InvitedAccess | { kind: "none" };

type Page<T> = { data: T[]; nextCursor: string | null };

export type RepoRecord = {
  name: string;
  connected: boolean;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  cleanupMode?: RepoPolicy["cleanupMode"];
  enabled?: boolean;
  checks?: RepoCheckFlags;
  checkPack?: { name: string };
};

export function githubAppInstallUrl(slug: string): string {
  const clean = slug.trim();
  if (!clean) throw new Error("GitHub App slug is required.");
  return `https://github.com/apps/${encodeURIComponent(clean)}/installations/new`;
}

export function activeGithubCredential(credentials: HubCredential[]): HubCredential | undefined {
  return credentials.find((item) =>
    item.name === GITHUB_CREDENTIAL_NAME
    && typeof item.status === "string"
    && item.status.toLowerCase() === "active",
  );
}

export function hasActiveGithubCredential(credentials: HubCredential[]): boolean {
  return activeGithubCredential(credentials) !== undefined;
}

export function githubAppSlugFromCredentials(credentials: HubCredential[]): string | null {
  const row = activeGithubCredential(credentials);
  const slug = row?.metadata && typeof row.metadata === "object" && typeof row.metadata["appSlug"] === "string"
    ? row.metadata["appSlug"].trim()
    : "";
  return slug || null;
}

export type HubCredential = typeof CredentialResponse.infer;
export type HubGrant = typeof GrantResponse.infer;
export type HubPrincipal = typeof PrincipalResponse.infer;
export type HubRole = typeof RoleResponse.infer;
export type HubApproval = typeof ApprovalResponse.infer;
export type HubRun = typeof WorkflowRunResponse.infer;

export type RunLog = {
  runId: string;
  anchorRunId: string;
  events: WorkflowRunEvent[];
};

export type SectionDenied = {
  repos: boolean;
  credentials: boolean;
};

export type PortalSnapshot = {
  workspace: Workspace;
  tenantName: string;
  /** Every triage workspace the user is an active member of, the open one included. */
  workspaces: WorkspaceOption[];
  invitations: WorkspaceOption[];
  repos: RepoRecord[];
  config?: AppConfig;
  configVersion?: string;
  credentials: HubCredential[];
  denied: SectionDenied;
};

type TenantBody = {
  id: string;
  name: string;
  slug: string;
  config?: Record<string, unknown>;
};

type ProviderBody = {
  id: string;
  name: string;
  plugin: string;
  apiBaseUrl?: string | null;
};

const MAX_LIST_PAGES = 100;

function enc(value: string): string {
  return encodeURIComponent(value);
}

function requireTenantId(tenantId: string): string {
  const trimmed = tenantId.trim();
  if (!trimmed) throw new Error("Tenant id is required.");
  return trimmed;
}

function requireId(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${what} is required.`);
  return trimmed;
}

export function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error("Repository must be owner/name.");
  }
  if (parts.some((part) => part === "." || part === "..") || trimmed.includes("..")) {
    throw new Error("Repository must not traverse paths.");
  }
  if (/[\s\\]/.test(trimmed)) {
    throw new Error("Repository must not contain whitespace or backslashes.");
  }
  return trimmed;
}

export function githubAppSecret(app: { appId: string; privateKey: string }): string {
  const { appId, privateKey } = app;
  if (!appId.trim() || !privateKey.trim()) {
    throw new Error("App ID and private key are required.");
  }
  return JSON.stringify({ appId: appId.trim(), privateKey: privateKey.trim() });
}

function requireSecret(secret: string): string {
  if (!secret || secret.trim().length === 0) throw new Error("Repository and credential are required.");
  return secret;
}

function requireContent(content: string, what: string): string {
  const trimmed = content.trim();
  if (!trimmed) throw new Error(`${what} must not be empty.`);
  return trimmed;
}

type Listed<T> = { rows: T[] | undefined; next: string | null };

/** Follows `nextCursor` until the hub runs out of pages or `enough` says the caller has what it came for. */
async function listPages<T>(transport: Transport, path: string, read: (raw: unknown) => Listed<T>, enough?: (items: T[]) => boolean): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const raw = await transport.fetch<unknown>(
      "GET",
      `${path}${separator}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    const { rows, next } = read(raw);
    if (!Array.isArray(rows)) {
      throw new Error("The hub returned a page without data.");
    }
    items.push(...rows);
    if (!next || seen.has(next) || enough?.(items)) return items;
    seen.add(next);
    cursor = next;
  }
  throw new Error("The hub paginated past its page limit.");
}

async function listAll<T>(transport: Transport, path: string): Promise<T[]> {
  return listPages<T>(transport, path, function readPage(raw) {
    if (Array.isArray(raw)) return { rows: raw as T[], next: null };
    const page = raw as Page<T> | undefined;
    return { rows: page?.data, next: page?.nextCursor ?? null };
  });
}

export const CONFIG_KEY = "corbitsTriage";

export type AppConfig = {
  repos?: unknown[];
  allowlist?: Record<string, string[]>;
  labelMap?: Record<string, string>;
  inference?: { endpoint: string; model: string };
  allowlistImport?: {
    at: string;
    organizationRuns: Array<{ repo: string; organization: string; count: number; runId: string }>;
  };
  rev?: number;
};

export function appConfig(config: unknown): AppConfig {
  if (!config || typeof config !== "object") return {};
  const ns = (config as Record<string, unknown>)[CONFIG_KEY];
  return ns && typeof ns === "object" ? (ns as AppConfig) : {};
}

/** Stable fingerprint (FNV-1a) of the app config, shown as the config version. */
function sortedKeys(_key: string, value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
    : value;
}

export function configFingerprint(config: unknown): string {
  const text = JSON.stringify(appConfig(config), sortedKeys);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const CONFIG_CAS_ATTEMPTS = 8;

/** PATCH replaces tenant config wholesale: spread existing keys, replace only our namespace. */
export async function patchAppConfig(
  transport: Transport,
  tenantId: string,
  update: (current: AppConfig) => AppConfig,
): Promise<void> {
  const tid = enc(requireTenantId(tenantId));
  let lastConflict: ApiError | undefined;
  for (let attempt = 0; attempt < CONFIG_CAS_ATTEMPTS; attempt += 1) {
    const tenant = await transport.fetch<TenantBody>("GET", `/api/tenants/${tid}`);
    const existing = tenant.config && typeof tenant.config === "object" ? tenant.config : {};
    const current = { ...appConfig(existing) };
    const next = { ...update(current), rev: current.rev ?? 0 };
    try {
      await transport.fetch("PATCH", `/api/tenants/${tid}`, { config: { ...existing, [CONFIG_KEY]: next } });
      return;
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
      lastConflict = cause;
    }
  }
  throw lastConflict ?? new ApiError(409, "config_conflict", "config_conflict");
}

export function reposFromConfig(config: unknown): RepoRecord[] {
  const repos = appConfig(config).repos;
  if (!Array.isArray(repos)) return [];
  const parsed: RepoRecord[] = [];
  for (const row of repos) {
    if (!row || typeof row !== "object") continue;
    const name = (row as { name?: unknown }).name;
    const connected = (row as { connected?: unknown }).connected;
    if (typeof name !== "string" || name.length === 0) continue;
    if (typeof connected !== "boolean") continue;
    const installationId = (row as { installationId?: unknown }).installationId;
    const account = (row as { account?: unknown }).account;
    const installationUrl = (row as { installationUrl?: unknown }).installationUrl;
    const selection = (row as { selection?: unknown }).selection;
    parsed.push({
      name,
      connected,
      ...repoPolicy(row),
      ...(typeof installationId === "number" ? { installationId } : {}),
      ...(typeof account === "string" ? { account } : {}),
      ...(typeof installationUrl === "string" ? { installationUrl } : {}),
      ...(selection === "all" || selection === "selected" ? { selection } : {}),
    });
  }
  return parsed;
}

export type ArtifactListItem = { id: string; title: string; kind?: string };
type ArtifactPage = { artifacts?: ArtifactListItem[]; nextCursor?: string | null };

/**
 * Artifact pages come newest first under `artifacts`. The hub matches `query`
 * against title or content, so callers filter titles exactly.
 */
export async function listArtifacts(
  transport: Transport,
  tenantId: string,
  query: string,
  enough?: (rows: ArtifactListItem[]) => boolean,
): Promise<ArtifactListItem[]> {
  const tid = enc(requireTenantId(tenantId));
  return listPages<ArtifactListItem>(transport, `/api/tenants/${tid}/artifacts?query=${enc(query)}`, function readPage(raw) {
    const page = raw as ArtifactPage | undefined;
    return { rows: page?.artifacts, next: page?.nextCursor ?? null };
  }, enough);
}

/** Titles are not unique; a title resolves to its newest artifact, which the listing order puts first. */
export function newestByTitle(rows: ArtifactListItem[]): Map<string, ArtifactListItem> {
  const byTitle = new Map<string, ArtifactListItem>();
  for (const row of rows) {
    if (!byTitle.has(row.title)) byTitle.set(row.title, row);
  }
  return byTitle;
}

export async function findArtifactByTitle(transport: Transport, tenantId: string, title: string): Promise<ArtifactListItem | null> {
  function found(rows: ArtifactListItem[]): boolean {
    return rows.some((row) => row.title === title);
  }
  return newestByTitle(await listArtifacts(transport, tenantId, title, found)).get(title) ?? null;
}

/** A check pack with the artifact it was read from; `version` is what a save must match. */
export type StoredCheckPack = { kind: "pack"; id: string; version: number; pack: CheckPack };
/** The newest artifact titled for the repository holds something that is not a check pack; a save replaces it in place. */
export type CorruptCheckPack = { kind: "corrupt"; id: string; version: number; reason: string };
export type CheckPackArtifact = StoredCheckPack | CorruptCheckPack;

export async function loadCheckPackById(transport: Transport, tenantId: string, repo: string, id: string): Promise<CheckPackArtifact> {
  const tid = enc(requireTenantId(tenantId));
  const detail = await transport.fetch<{ artifact?: { content?: string; version?: number } }>(
    "GET",
    `/api/tenants/${tid}/artifacts/${enc(id)}`,
  );
  const version = detail.artifact?.version;
  if (typeof version !== "number") throw new Error("The hub returned an artifact without a version.");
  try {
    return { kind: "pack", id, version, pack: readCheckPack(detail.artifact?.content, repo) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: "corrupt", id, version, reason: error.message };
  }
}

/** The one title-to-detail path: the newest artifact titled for the repository, read in full. */
export async function loadRepoCheckPack(transport: Transport, tenantId: string, repo: string): Promise<CheckPackArtifact | null> {
  const clean = validateRepo(repo);
  const listed = await findArtifactByTitle(transport, tenantId, checkPackName(clean));
  if (!listed) return null;
  return loadCheckPackById(transport, tenantId, clean, listed.id);
}

export type CheckPackLookup = (repo: string) => Promise<boolean>;

async function withPackPointers(repos: RepoRecord[], hasPack: CheckPackLookup): Promise<RepoRecord[]> {
  return Promise.all(repos.map(async function linkExistingPack(repo) {
    if (repo.checkPack?.name?.trim()) return repo;
    return (await hasPack(repo.name)) ? { ...repo, checkPack: { name: checkPackName(repo.name) } } : repo;
  }));
}

export async function loadRepoPolicy(transport: Transport, tenantId: string, repo: string): Promise<RepoPolicy> {
  const tid = enc(requireTenantId(tenantId));
  const tenant = await transport.fetch<TenantBody>("GET", `/api/tenants/${tid}`);
  const row = reposFromConfig(tenant.config).find((item) => item.name === repo);
  return repoPolicy(row);
}

function assertRepoEnabled(policy: RepoPolicy): void {
  if (!policy.enabled) {
    throw new Error("Triage is disabled for this repository. Enable it first.");
  }
}

/** One config write: the panel's settings, plus the pointer at the repository's pack when it has one. */
export async function saveRepoSettings(
  transport: Transport,
  tenantId: string,
  repo: string,
  settings: Pick<RepoPolicy, "cleanupMode" | "enabled" | "triageDrafts" | "roles">,
  linked: boolean,
): Promise<void> {
  const clean = validateRepo(repo);
  const { cleanupMode, enabled, triageDrafts, roles } = settings;
  const next = { cleanupMode, enabled, triageDrafts, roles, ...(linked ? { checkPack: { name: checkPackName(clean) } } : {}) };
  await patchAppConfig(transport, tenantId, function applySettings(current) {
    const repos = current.repos ?? [];
    if (!repos.some((row) => rowName(row) === clean)) throw new Error("Repository not found.");
    return { ...current, repos: repos.map((row) => (rowName(row) === clean ? { ...(row as object), ...next } : row)) };
  });
}

type HubMe = { id: string; name?: string; email?: string };

function rowName(row: unknown): unknown {
  return row && typeof row === "object" ? (row as { name?: unknown }).name : undefined;
}

function isTriageSlug(slug: string | undefined): boolean {
  return slug === WORKSPACE_SLUG || Boolean(slug?.startsWith(`${WORKSPACE_SLUG}-`));
}

function optionOf(entry: Membership): WorkspaceOption {
  return { tenantId: entry.tenantId, name: entry.tenantName, slug: entry.tenantSlug };
}

/**
 * The chosen workspace while the user is still active in it. Otherwise the newest workspace they joined, ahead of the one
 * the portal created for them, so a stray workspace of their own never hides the team's. Invitations stand in only when no
 * workspace is active.
 */
function chooseWorkspace(memberships: Membership[], user: HubMe, chosen: string | null): WorkspaceAccess {
  const own = workspaceSlugFor(user);
  const triage = memberships.filter((entry) => entry.kind === "user" && isTriageSlug(entry.tenantSlug));
  const active = triage.filter((entry) => entry.status === "active");
  const invitations = triage.filter((entry) => entry.status === "invited").map(optionOf);
  const open = active.find((entry) => entry.tenantId === chosen) ?? active.find((entry) => entry.tenantSlug !== own) ?? active[0];
  if (open) {
    const workspace = { tenantId: open.tenantId, principalId: open.principalId, userId: user.id };
    return { kind: "member", workspace, workspaces: active.map(optionOf), invitations };
  }
  if (invitations.length > 0) return { kind: "invited", invitations };
  return { kind: "none" };
}

/** Two workspaces can share a name; the slug tells them apart. */
export function sharesName(option: WorkspaceOption, options: WorkspaceOption[]): boolean {
  return options.some((other) => other.tenantId !== option.tenantId && other.name === option.name);
}

export async function resolveWorkspace(transport: Transport, chosen: string | null): Promise<WorkspaceAccess> {
  const user = await transport.fetch<HubMe | null>("GET", "/api/me");
  if (!user?.id) throw new Error("The hub did not return the signed-in user.");
  return chooseWorkspace(await listAll<Membership>(transport, "/api/me/principals"), user, chosen);
}

export async function inviteRoles(transport: Transport, tenantId: string): Promise<string[]> {
  return InviteRoles.assert(await transport.fetch<unknown>("GET", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}`)).assignableRoleIds;
}

export async function listInvited(transport: Transport, tenantId: string): Promise<HubPrincipal[]> {
  return listAll<HubPrincipal>(transport, `/api/tenants/${enc(requireTenantId(tenantId))}/principals?kind=user&status=invited`);
}

export async function createInvitation(transport: Transport, tenantId: string, input: { email: string; roleId: string }): Promise<InviteSent> {
  return InviteSent.assert(await transport.fetch<unknown>("POST", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}`, input));
}

export async function resendInvitation(transport: Transport, tenantId: string, principalId: string): Promise<InviteSent> {
  return InviteSent.assert(await transport.fetch<unknown>("POST", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}/${enc(requireId(principalId, "Principal id"))}/resend`, {}));
}

export async function withdrawInvitation(transport: Transport, tenantId: string, principalId: string): Promise<void> {
  await transport.fetch("DELETE", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}/${enc(requireId(principalId, "Principal id"))}`, {});
}

export async function acceptInvitation(transport: Transport, tenantId: string): Promise<void> {
  await transport.fetch("POST", "/api/integrations/invite-accept", { tenantId: requireTenantId(tenantId) });
}

export type HubSessionRow = (typeof SessionList.infer)["sessions"][number];

export async function listSessions(transport: Transport): Promise<HubSessionRow[]> {
  return SessionList.assert(await transport.fetch<unknown>("GET", "/api/integrations/sessions")).sessions;
}

export async function revokeSession(transport: Transport, sessionId: string): Promise<void> {
  await transport.fetch("DELETE", `/api/integrations/sessions/${enc(requireId(sessionId, "Session id"))}`, {});
}

function workspaceNameFor(user: HubMe): string {
  const who = user.name?.trim() || user.email?.split("@")[0];
  if (!who) throw new Error("The hub returned a user without a name or email.");
  return `${who}'s workspace`;
}

/** Stable per user, so a retry after a dropped response targets the same slug. */
export function workspaceSlugFor(user: HubMe): string {
  const local = (user.email?.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const suffix = user.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-6);
  return [WORKSPACE_SLUG, local, suffix].filter(Boolean).join("-");
}

async function createWorkspace(transport: Transport): Promise<MemberAccess | InvitedAccess> {
  const user = await transport.fetch<HubMe>("GET", "/api/me");
  try {
    await transport.fetch("POST", "/api/tenants", { name: workspaceNameFor(user), slug: workspaceSlugFor(user) });
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const raced = await resolveWorkspace(transport, null);
    if (raced.kind === "none") throw cause;
    return raced;
  }
  const resolved = await resolveWorkspace(transport, null);
  if (resolved.kind === "none") throw new Error("The hub created the workspace but does not list it.");
  return resolved;
}

/** Opens a workspace the user is active in, else reports their invitations; only a user with neither gets a workspace of their own. */
export async function ensureWorkspace(transport: Transport, chosen: string | null): Promise<MemberAccess | InvitedAccess> {
  const existing = await resolveWorkspace(transport, chosen);
  if (existing.kind !== "none") return existing;
  return createWorkspace(transport);
}

/** Workflow the app-level hook credential targets (metadata.webhook.workflow). */
export const HOOK_WORKFLOW = "pr-triage";

export function legacyHookCredentials(credentials: HubCredential[]): HubCredential[] {
  return credentials.filter((row) => row.name.startsWith(`${GITHUB_HOOK_CREDENTIAL_NAME}:`));
}

export function legacyGithubCredentials(credentials: HubCredential[]): HubCredential[] {
  return credentials.filter((row) => row.name.startsWith(`${GITHUB_CREDENTIAL_NAME}:`));
}

function credentialIdempotencyKey(providerId: string, name: string): string {
  return `${providerId}:${name}`;
}

function pickProvider(providers: ProviderBody[], name: string): ProviderBody | undefined {
  const matches = providers.filter((row) => row.name === name);
  if (matches.length > 1) {
    console.warn(`hub-api: ${matches.length} ${name} providers; picking deterministically by id.`);
  }
  return [...matches].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

export async function ensureGitHubProvider(transport: Transport, tenantId: string): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const existing = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), GITHUB_PROVIDER);
  const apiBaseUrl = githubProviderApiBaseUrl();
  if (existing) {
    if (existing.plugin !== GITHUB_PROVIDER_PLUGIN || existing.apiBaseUrl !== apiBaseUrl) {
      await transport.fetch("PATCH", `/api/tenants/${tid}/providers/${enc(existing.id)}`, {
        plugin: GITHUB_PROVIDER_PLUGIN,
        apiBaseUrl,
      });
    }
    return existing.id;
  }
  try {
    const created = await transport.fetch<ProviderBody>("POST", `/api/tenants/${tid}/providers`, {
      name: GITHUB_PROVIDER,
      plugin: GITHUB_PROVIDER_PLUGIN,
      apiBaseUrl,
    });
    return created.id;
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const raced = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), GITHUB_PROVIDER);
    if (raced) return raced.id;
    throw cause;
  }
}

const REACTIVATABLE_CREDENTIAL_STATUSES = new Set(["expired", "inactive"]);

async function writeGitHubCredential(
  transport: Transport,
  tenantId: string,
  secret: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const providerId = await ensureGitHubProvider(transport, tenantId);
  const name = GITHUB_CREDENTIAL_NAME;
  try {
    const created = await transport.fetch<HubCredential>("POST", `/api/tenants/${tid}/credentials`, {
      providerId,
      name,
      type: "api_key",
      secret,
      ...(metadata ? { metadata } : {}),
      idempotencyKey: credentialIdempotencyKey(providerId, name),
    });
    return created.id;
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/resolve/${enc(name)}`,
    );
    const current = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/${enc(existing.id)}`,
    );
    const status = typeof current.status === "string" ? current.status.toLowerCase() : "";
    if (status !== "active" && !REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) {
      const label = typeof current.status === "string" && current.status.length > 0 ? current.status : "unknown";
      throw new Error(`The credential ${name} is ${label} — re-authorize the GitHub App.`);
    }
    const body: Record<string, unknown> = { secret };
    if (metadata) body.metadata = metadata;
    if (REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) body.status = "active";
    await transport.fetch("PATCH", `/api/tenants/${tid}/credentials/${enc(existing.id)}`, body);
    return existing.id;
  }
}

export async function configureGithubApp(
  transport: Transport,
  tenantId: string,
  secret: string,
  legacyCredentialIds: string[] = [],
  appSlug?: string,
): Promise<void> {
  const slug = appSlug?.trim();
  const id = await writeGitHubCredential(
    transport,
    tenantId,
    requireSecret(secret),
    slug ? { appSlug: slug } : undefined,
  );
  await Promise.all(legacyCredentialIds.filter((legacyId) => legacyId !== id).map((legacyId) =>
    revokeCredential(transport, tenantId, legacyId)
  ));
}

/**
 * Converges the app-level hook credential GitHub posts to. The secret is the
 * GitHub webhook signing secret (never the GitHub API credential); the
 * metadata lets the stock /api/hooks routes verify (standard-webhooks) and
 * resolve the pr-triage workflow. Returns the credential id for the hook URL.
 */
export async function ensureHookCredential(
  transport: Transport,
  tenantId: string,
  secret: string,
): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const hookSecret = requireSecret(secret);
  const providerId = await ensureGitHubProvider(transport, tenantId);
  const name = GITHUB_HOOK_CREDENTIAL_NAME;
  const metadata = { webhook: { verify: "standard-webhooks", workflow: HOOK_WORKFLOW } };
  try {
    const created = await transport.fetch<HubCredential>("POST", `/api/tenants/${tid}/credentials`, {
      providerId,
      name,
      type: "api_key",
      secret: hookSecret,
      metadata,
      idempotencyKey: credentialIdempotencyKey(providerId, name),
    });
    return created.id;
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/resolve/${enc(name)}`,
    );
    const current = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/${enc(existing.id)}`,
    );
    const status = typeof current.status === "string" ? current.status.toLowerCase() : "";
    if (status !== "active" && !REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) {
      const label = typeof current.status === "string" && current.status.length > 0 ? current.status : "unknown";
      throw new Error(`The credential ${name} is ${label} — re-authorize it before configuring the webhook.`);
    }
    const body: Record<string, unknown> = { secret: hookSecret, metadata };
    if (REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) body.status = "active";
    await transport.fetch("PATCH", `/api/tenants/${tid}/credentials/${enc(existing.id)}`, body);
    return existing.id;
  }
}

export async function configureGithubHook(
  transport: Transport,
  tenantId: string,
  secret: string,
  legacyCredentialIds: string[] = [],
): Promise<string> {
  const id = await ensureHookCredential(transport, tenantId, secret);
  await Promise.all(legacyCredentialIds.filter((legacyId) => legacyId !== id).map((legacyId) =>
    revokeCredential(transport, tenantId, legacyId)
  ));
  return id;
}

function requireHttpsUrl(value: string, what: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${what} is required.`);
  if (!/^https:\/\//i.test(trimmed)) throw new Error(`${what} must be an HTTPS URL.`);
  return trimmed;
}

async function ensureInferenceProvider(transport: Transport, tenantId: string, endpoint: string): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const existing = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), INFERENCE_PROVIDER);
  const body = { plugin: INFERENCE_PROVIDER_PLUGIN, apiBaseUrl: endpoint };
  if (existing) {
    if (existing.plugin !== INFERENCE_PROVIDER_PLUGIN || existing.apiBaseUrl !== endpoint) {
      await transport.fetch("PATCH", `/api/tenants/${tid}/providers/${enc(existing.id)}`, body);
    }
    return existing.id;
  }
  try {
    const created = await transport.fetch<ProviderBody>("POST", `/api/tenants/${tid}/providers`, {
      name: INFERENCE_PROVIDER,
      plugin: INFERENCE_PROVIDER_PLUGIN,
      apiBaseUrl: endpoint,
    });
    return created.id;
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const raced = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), INFERENCE_PROVIDER);
    if (raced) {
      if (raced.plugin !== INFERENCE_PROVIDER_PLUGIN || raced.apiBaseUrl !== endpoint) {
        await transport.fetch("PATCH", `/api/tenants/${tid}/providers/${enc(raced.id)}`, body);
      }
      return raced.id;
    }
    throw cause;
  }
}

export async function saveInference(
  transport: Transport,
  tenantId: string,
  input: { endpoint: string; model: string; secret: string },
): Promise<void> {
  const endpoint = requireHttpsUrl(input.endpoint, "Endpoint");
  const model = requireContent(input.model, "Model");
  if (!input.secret.trim()) throw new Error("Secret is required.");
  const secret = requireSecret(input.secret);
  const tid = enc(requireTenantId(tenantId));
  const providerId = await ensureInferenceProvider(transport, tenantId, endpoint);
  const name = INFERENCE_CREDENTIAL_NAME;
  let credentialId: string;
  try {
    ({ id: credentialId } = await transport.fetch<HubCredential>("POST", `/api/tenants/${tid}/credentials`, {
      providerId,
      name,
      type: "api_key",
      secret,
      metadata: { model, endpoint },
      idempotencyKey: credentialIdempotencyKey(providerId, name),
    }));
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const existing = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/resolve/${enc(name)}`,
    );
    const current = await transport.fetch<HubCredential>(
      "GET",
      `/api/tenants/${tid}/credentials/${enc(existing.id)}`,
    );
    const status = typeof current.status === "string" ? current.status.toLowerCase() : "";
    if (status !== "active" && !REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) {
      const label = typeof current.status === "string" && current.status.length > 0 ? current.status : "unknown";
      throw new Error(`The inference secret is ${label} — save a new secret.`);
    }
    const patch: Record<string, unknown> = { secret, metadata: { model, endpoint } };
    if (REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) patch.status = "active";
    await transport.fetch("PATCH", `/api/tenants/${tid}/credentials/${enc(existing.id)}`, patch);
    credentialId = existing.id;
  }
  await ensureInferenceOffering(transport, tenantId, { endpoint, model, credentialId });
  await patchAppConfig(transport, tenantId, function setInference(current) {
    return { ...current, inference: { endpoint, model } };
  });
}

type CatalogRow = { id: string; name?: string; canonicalName?: string; baseURL?: string; modelId?: string; providerId?: string; quirks?: Record<string, unknown> | null };

/** Catalog provider, model, and offering the triage workflows deploy onto; reuses rows that already match. */
async function ensureInferenceOffering(
  transport: Transport,
  tenantId: string,
  input: { endpoint: string; model: string; credentialId: string },
): Promise<void> {
  const base = `/api/tenants/${enc(requireTenantId(tenantId))}/catalog`;
  const providers = await listAll<CatalogRow>(transport, `${base}/providers`);
  let provider = providers.find((row) => row.name === INFERENCE_PROVIDER);
  if (!provider) {
    provider = await transport.fetch<CatalogRow>("POST", `${base}/providers`, {
      name: INFERENCE_PROVIDER,
      plugin: INFERENCE_PROVIDER_PLUGIN,
      baseURL: input.endpoint,
      credentialId: input.credentialId,
    });
  } else if (provider.baseURL !== input.endpoint) {
    await transport.fetch("PATCH", `${base}/providers/${enc(provider.id)}`, { baseURL: input.endpoint });
  }
  const models = await listAll<CatalogRow>(transport, `${base}/models`);
  const model = models.find((row) => row.canonicalName === DECISION_MODEL_ALIAS)
    ?? await transport.fetch<CatalogRow>("POST", `${base}/models`, { canonicalName: DECISION_MODEL_ALIAS });
  const quirks = { model: input.model };
  const offerings = await listAll<CatalogRow>(transport, `${base}/offerings`);
  const offering = offerings.find((row) => row.modelId === model.id && row.providerId === provider.id);
  if (!offering) {
    await transport.fetch("POST", `${base}/offerings`, { modelId: model.id, providerId: provider.id, priority: 0, quirks });
  } else if (JSON.stringify(offering.quirks) !== JSON.stringify(quirks)) {
    await transport.fetch("PATCH", `${base}/offerings/${enc(offering.id)}`, { quirks });
  }
}

async function forgetRepo(transport: Transport, tenantId: string, repo: string): Promise<void> {
  await patchAppConfig(transport, tenantId, function dropRepo(current) {
    return { ...current, repos: (current.repos ?? []).filter((row) => rowName(row) !== repo) };
  });
}

// Interchange's `liveWorkflowRunStatuses`: an anchor is born `deployed` and
// flips to `running` on its first trigger. The db package that defines it is
// server-only, so the set is repeated here.
const LIVE_DEPLOYMENT_STATUSES = new Set(["deployed", "running"]);

export function isLiveDeployment(status: string): boolean {
  return LIVE_DEPLOYMENT_STATUSES.has(status);
}

/** A live deployment with the versions its frozen closure pins; `package` is null when it was not deployed from the package registry. */
export type DeployedWorkflow = DeployedVersions["deployments"][number];

/** Live deployments of every workflow, newest first. */
export async function listDeployedWorkflows(transport: Transport, tenantId: string): Promise<DeployedWorkflow[]> {
  const tid = enc(requireTenantId(tenantId));
  return DeployedVersions.assert(await transport.fetch<unknown>("GET", `/api/integrations/workflow-versions/${tid}`)).deployments;
}

/** The deployment a workflow's mail goes to: its newest one not being cancelled. */
export function currentDeployment(deployments: readonly DeployedWorkflow[], workflow: string): DeployedWorkflow | undefined {
  return deployments.find((deployment) => deployment.workflow === workflow && !deployment.cancelling);
}

export const SERVICE_NOT_RUNNING = "The service is not running. Restart the hub, then try again.";

function isTerminalMailFailure(cause: unknown): boolean {
  if (cause instanceof ApiError && cause.code === "deployment_unreachable") return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("terminal and cannot receive more mail")
    || message.includes("workflow_run_terminal")
    || message.includes("deployment_unreachable")
    || message.includes("allocation is")
    || message.includes("no longer active");
}

export const WAITING_FOR_WORKFLOW = "Waiting for the workflow to be ready…";

// A deployment answers 409 `deployment_not_ready` until it records its credential resolution, seconds after it is deployed.
const NOT_READY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

function isDeploymentNotReady(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.code === "deployment_not_ready";
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries `attempt` while the deployment is not ready, calling `onWait` once; the last attempt's error is thrown as is. */
export async function untilDeploymentReady<T>(
  attempt: () => Promise<T>,
  onWait: () => void,
  sleep: (ms: number) => Promise<void> = pause,
): Promise<T> {
  for (const [index, ms] of NOT_READY_BACKOFF_MS.entries()) {
    try {
      return await attempt();
    } catch (cause) {
      if (!isDeploymentNotReady(cause)) throw cause;
    }
    if (index === 0) onWait();
    await sleep(ms);
  }
  return attempt();
}

function byPreferredDeployment(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

async function triggerNamedWorkflow(
  transport: Transport,
  tenantId: string,
  definitionName: string,
  content: string,
  trackBody = false,
): Promise<{ runId: string; deploymentId: string; priorBodyRunIds: ReadonlySet<string> }> {
  const tid = enc(requireTenantId(tenantId));
  const [deployments, assets] = await Promise.all([
    listWorkflowDeployments(transport, tenantId),
    transport.fetch<Array<{ id: string; kind: string; name: string }>>(
      "GET",
      `/api/tenants/${tid}/assets?kind=workflow`,
    ),
  ]);
  const assetIds = new Set(assets.filter((asset) => asset.kind === "workflow" && asset.name === definitionName).map((asset) => asset.id));
  const matches = deployments.filter((deployment) => assetIds.has(deployment.definitionAssetId));
  const live = matches
    .filter((deployment) => isLiveDeployment(deployment.status))
    .sort(byPreferredDeployment);
  const deploymentId = live[0]?.id;
  if (!deploymentId) {
    if (matches.length > 0) throw new Error(SERVICE_NOT_RUNNING);
    throw new Error(`The hub has no ${definitionName} deployment to run.`);
  }
  const priorBodyRunIds = new Set<string>();
  if (trackBody) {
    try {
      const existing = await readWorkflowRunEvents(transport, tenantId, deploymentId, deploymentId);
      for (const event of existing.events) {
        if (event.type !== "ChildSpawned") continue;
        const body = obj(event.body);
        if (body.stepId === "events" && typeof body.childRunId === "string") priorBodyRunIds.add(body.childRunId);
      }
    } catch (cause) {
      // A fresh deployment has no durable event log until its first real mail.
      if (!(cause instanceof ApiError && cause.status === 404)) throw cause;
    }
  }
  try {
    const triggered = await triggerWorkflowRun(transport, tenantId, deploymentId, { content });
    return { runId: triggered.runId, deploymentId, priorBodyRunIds };
  } catch (cause) {
    if (isTerminalMailFailure(cause)) throw new Error(SERVICE_NOT_RUNNING);
    throw cause;
  }
}

/** A live pr-triage-historical run the hub already deployed. Does not invent a definition source. */
export async function startBacklogTriage(
  transport: Transport,
  tenantId: string,
  repo: string,
): Promise<{ runId: string }> {
  const clean = validateRepo(repo);
  const policy = await loadRepoPolicy(transport, tenantId, clean);
  assertRepoEnabled(policy);
  const read = await loadRepoCheckPack(transport, tenantId, clean);
  if (!read) throw new Error("This repository still needs check setup.");
  if (read.kind === "corrupt") throw new Error(`This repository's check pack is unreadable: ${read.reason} Replace it on the repository page.`);
  const pack = read.pack;
  const { runId } = await triggerNamedWorkflow(
    transport,
    tenantId,
    BACKLOG_WORKFLOW,
    JSON.stringify({ kind: "backlog", repo: clean, policy: { ...policy, checkPack: { name: checkPackName(clean) } }, checkPack: pack }),
  );
  return { runId };
}

/** Asks the hub to queue one open pull request on its live pr-triage deployment. */
export async function triagePullRequest(transport: Transport, tenantId: string, repo: string, number: number): Promise<void> {
  const clean = validateRepo(repo);
  if (!Number.isInteger(number) || number < 1) throw new Error("Pull request number must be a positive integer.");
  await transport.fetch("POST", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}`, { repo: clean, number });
}

export type OpenPulls = {
  repos: Array<{
    repo: string;
    prs: Array<{ number: number; title: string; author: string | null; authorKind?: AuthorKind; draft: boolean; sha: string; updatedAt: string; labels: string[] }>;
    error?: string;
  }>;
};

export type PrGithubWriteInput =
  | { action: "comment"; repo: string; number: number; body: string }
  | { action: "reply"; repo: string; number: number; body: string }
  | { action: "labels"; repo: string; number: number; labels: string[] }
  | { action: "assign"; repo: string; number: number; assignees: string[] }
  | { action: "request-review"; repo: string; number: number; reviewers?: string[]; teamReviewers?: string[] }
  | { action: "review"; repo: string; number: number; event: "REQUEST_CHANGES"; body: string }
  | { action: "review"; repo: string; number: number; event: "APPROVE"; body: string; headSha: string }
  | { action: "merge"; repo: string; number: number; headSha: string }
  | { action: "close"; repo: string; number: number; labels: string[]; comment: string };

/** The hub answers a reply with the GitHub comment it wrote; other writes carry none. */
export type PrGithubWriteResult = { commentId: number | null };

export async function githubPrAction(transport: Transport, tenantId: string, input: PrGithubWriteInput): Promise<PrGithubWriteResult> {
  const repo = validateRepo(input.repo);
  if (!Number.isInteger(input.number) || input.number < 1) throw new Error("Pull request number must be a positive integer.");
  if ((input.action === "comment" || input.action === "reply") && !input.body.trim()) throw new Error("Comment must not be empty.");
  if (input.action === "review" && input.event !== "APPROVE" && !input.body.trim()) {
    throw new Error("Review body must not be empty.");
  }
  const result = obj(await transport.fetch<unknown>("POST", `/api/integrations/github-actions/${enc(requireTenantId(tenantId))}`, { ...input, repo }));
  return { commentId: typeof result.commentId === "number" ? result.commentId : null };
}

/** Names one held Do by the run whose verdict holds it; the hub looks the Do up and mails the deployment to run it. */
export type HeldDoRef = { runId: string; repo: string; number: number; effectId: string };

/** The hub's refusals that name its internals; the rest of its text is already plain. */
const DO_REFUSALS: Record<string, string> = {
  do_not_held: "This action is not waiting for approval. Run triage again.",
  verdict_superseded: "A newer triage result exists. Approve from it instead.",
};

/** The hub hands the Do to pr-triage, which runs it once on the head the verdict judged. */
export async function approveHeldDo(transport: Transport, tenantId: string, ref: HeldDoRef): Promise<void> {
  try {
    await transport.fetch<unknown>("POST", `/api/integrations/github-held-dos/${enc(requireTenantId(tenantId))}`, { ...ref, repo: validateRepo(ref.repo) });
  } catch (cause) {
    const plain = cause instanceof ApiError ? DO_REFUSALS[cause.code] : undefined;
    throw plain === undefined ? cause : new Error(plain);
  }
}

export async function loadTriageStats(transport: Transport, tenantId: string, repo: string, days: number): Promise<TriageStats> {
  return TriageStats.assert(await transport.fetch<unknown>("GET", `/api/integrations/triage-stats/${enc(requireTenantId(tenantId))}?repo=${enc(validateRepo(repo))}&days=${days}`));
}

export type CheckChange = { check: string; from: string | null; to: string | null };

/** One recorded verdict of a pull request, as the hub's triage-timeline route answers; repeats of the same outcome are left out. */
export type TimelineEntry = {
  at: string;
  runId: string;
  headSha: string;
  state: string;
  actor: string;
  /** False while the verdict waits on something, such as a check GitHub had not computed yet. */
  settled: boolean;
  degraded: string | null;
  /** 0–100; null when the verdict has no checks or is degraded. */
  readiness: number | null;
  changed: CheckChange[];
};

export type TriageTimeline = { repo: string; number: number; entries: TimelineEntry[] };

export async function loadTriageTimeline(transport: Transport, tenantId: string, repo: string, number: number): Promise<TriageTimeline> {
  return transport.fetch<TriageTimeline>("GET", `/api/integrations/triage-timeline/${enc(requireTenantId(tenantId))}?repo=${enc(validateRepo(repo))}&number=${number}`);
}

export type PullTriage = TriageVerdicts["pulls"][number];

/** One recorded verdict of a pull request. */
export type PullVerdict = NonNullable<PullTriage["verdict"]>;

export type PullRun = NonNullable<PullTriage["run"]>;

/** The open pull requests' latest verdicts, or with `pull` that one pull request's, open or not. */
export async function loadTriageVerdicts(transport: Transport, tenantId: string, pull?: { repo: string; number: number }): Promise<TriageVerdicts> {
  const query = pull === undefined ? "" : `?repo=${enc(validateRepo(pull.repo))}&number=${pull.number}`;
  return TriageVerdicts.assert(await transport.fetch<unknown>("GET", `/api/integrations/triage-verdicts/${enc(requireTenantId(tenantId))}${query}`));
}

export type GithubPullDetail = {
  pr: {
    number: number;
    title: string;
    body: string | null;
    state: string;
    merged: boolean;
    draft: boolean;
    author: string | null;
    sha: string;
    base: string;
    mergeable: boolean | null;
    requestedReviewers: number;
    additions: number;
    deletions: number;
    changedFiles: number;
    labels: string[];
    createdAt: string;
    updatedAt: string;
  };
  files: Array<{ path: string; previousPath?: string; status: string; additions: number; deletions: number; patch?: string }>;
  commits: Array<{ sha: string; message: string; author: string; committedAt: string }>;
  comments: Array<{ id: number | string; author: string; body: string; createdAt: string }>;
  issues: Array<{ number: number; title: string; state: string; body: string | null; url: string }>;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews: Array<{ reviewer: string; state: string; submittedAt: string; commitId: string }>;
};

export async function loadGithubPull(
  transport: Transport,
  tenantId: string,
  repo: string,
  number: number,
): Promise<GithubPullDetail> {
  if (!Number.isInteger(number) || number < 1) throw new Error("Pull request number must be a positive integer.");
  return transport.fetch<GithubPullDetail>(
    "GET",
    `/api/integrations/github-pull/${enc(requireTenantId(tenantId))}?repo=${enc(validateRepo(repo))}&number=${number}`,
  );
}

/** One Do as a preview resolves it; `skipped` ones carry why instead of an effect id. */
export type PreviewDo = { id: string; branch: DoBranch; index: number; kind: ActionKind; automatic: boolean; reason: string; effectId?: string; target?: Record<string, unknown>; skipped?: true };

export type PreviewBranch = { branch: DoBranch; reason: string; dos: PreviewDo[] };

export type PreviewAction =
  | { id: string; status: "not-woken" }
  | { id: string; status: "skipped"; reason: string }
  | ({ id: string; status: "decided" } & PreviewBranch)
  | { id: string; status: "waits-on-judge"; branches: PreviewBranch[] };

export type PreviewCheck = { check: string; name: string; kind: "machine" | "model"; result: "pass" | "fail" | "unconfirmed" | "needs-judge"; reason: string; evidence: string[]; output: CheckOutput };

export type PullPreview = {
  repo: string;
  number: number;
  headSha: string;
  event: TriageEvent;
  pack: "saved" | "candidate";
  judge: "not-needed" | "not-run";
  verdict: {
    state: string;
    priority: string;
    labels: string[];
    owner: string;
    humanGated: boolean;
    score: number | null;
    confidence: number | "unknown";
    merge: MergeVerdict;
    degraded: "inference-outage" | "error" | null;
    reason: string;
    nextAction: string;
    actor: "author" | "maintainer" | "system";
    feedback: string;
  };
  checks: PreviewCheck[];
  actions: PreviewAction[];
};

/** Evaluates `pack` and `roles`, saved or not, against one open pull request; the hub writes nothing and does not run the judge. */
export async function previewPull(
  transport: Transport,
  tenantId: string,
  input: { repo: string; number: number; pack: CheckPack; roles: Record<string, RepoRole> },
): Promise<PullPreview> {
  const repo = validateRepo(input.repo);
  if (!Number.isInteger(input.number) || input.number < 1) throw new Error("Pull request number must be a positive integer.");
  return transport.fetch<PullPreview>("POST", `/api/integrations/github-preview/${enc(requireTenantId(tenantId))}`, { ...input, repo });
}

const connectChains = new Map<string, Promise<unknown>>();

function serializePerTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
  const previous = connectChains.get(tenantId);
  async function runAfterPrevious(): Promise<T> {
    await previous;
    return work();
  }
  async function release(): Promise<void> {
    try {
      await next;
    } catch {
      // The caller receives the failure; the chain only orders writes.
    }
    if (connectChains.get(tenantId) === tracked) connectChains.delete(tenantId);
  }
  const next = runAfterPrevious();
  const tracked = release();
  connectChains.set(tenantId, tracked);
  return next;
}

/** The portal does not call GitHub. A missing workflow deployment is an error, not seed data. */
export async function removeRepository(
  transport: Transport,
  tenantId: string,
  repo: string,
): Promise<void> {
  const clean = validateRepo(repo);
  const key = requireTenantId(tenantId);
  await serializePerTenant(key, function remove() {
    return forgetRepo(transport, tenantId, clean);
  });
}

export async function replaceCredential(
  transport: Transport,
  tenantId: string,
  credentialId: string,
  secret: string,
): Promise<void> {
  const tid = enc(requireTenantId(tenantId));
  const cid = enc(requireId(credentialId, "Credential id"));
  const clean = requireSecret(secret);
  await transport.fetch("PATCH", `/api/tenants/${tid}/credentials/${cid}`, {
    secret: clean,
    status: "active",
  });
}

export async function revokeCredential(
  transport: Transport,
  tenantId: string,
  credentialId: string,
): Promise<void> {
  const tid = enc(requireTenantId(tenantId));
  const cid = enc(requireId(credentialId, "Credential id"));
  await transport.fetch("DELETE", `/api/tenants/${tid}/credentials/${cid}`);
}

export async function listPrincipals(transport: Transport, tenantId: string): Promise<HubPrincipal[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubPrincipal>(transport, `/api/tenants/${tid}/principals?kind=user&status=active`);
}

export async function listRoles(transport: Transport, tenantId: string): Promise<HubRole[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubRole>(transport, `/api/tenants/${tid}/roles`);
}

export async function createRole(transport: Transport, tenantId: string, name: string): Promise<HubRole> {
  const tid = enc(requireTenantId(tenantId));
  return transport.fetch<HubRole>("POST", `/api/tenants/${tid}/roles`, { name: requireId(name, "Role name") });
}

export async function renameRole(transport: Transport, tenantId: string, roleId: string, name: string): Promise<HubRole> {
  const tid = enc(requireTenantId(tenantId));
  const rid = enc(requireId(roleId, "Role id"));
  return transport.fetch<HubRole>("PATCH", `/api/tenants/${tid}/roles/${rid}`, { name: requireId(name, "Role name") });
}

export async function deleteRole(transport: Transport, tenantId: string, roleId: string): Promise<void> {
  const tid = enc(requireTenantId(tenantId));
  const rid = enc(requireId(roleId, "Role id"));
  await transport.fetch("DELETE", `/api/tenants/${tid}/roles/${rid}`);
}

/** Stock evaluate: whether `principalId` may do `action` on `resource`, as the hub would decide it. */
export async function evaluateAccess(
  transport: Transport,
  tenantId: string,
  principalId: string,
  resource: string,
  action: string,
): Promise<boolean> {
  const tid = enc(requireTenantId(tenantId));
  const pid = enc(requireId(principalId, "Principal id"));
  const result = await transport.fetch<{ effect: string }>("POST", `/api/tenants/${tid}/principals/${pid}/evaluate`, { resource, action });
  return result.effect === "allow";
}

export async function createGrant(
  transport: Transport,
  tenantId: string,
  input: CreateGrantInput,
): Promise<HubGrant> {
  const tid = enc(requireTenantId(tenantId));
  const body = createGrantBody(input);
  return transport.fetch<HubGrant>("POST", `/api/tenants/${tid}/grants`, body);
}

export async function deleteGrant(
  transport: Transport,
  tenantId: string,
  grant: Pick<HubGrant, "id" | "origin">,
): Promise<void> {
  assertCanRemoveGrant(grant);
  const tid = enc(requireTenantId(tenantId));
  const gid = enc(requireId(grant.id, "Grant id"));
  await transport.fetch("DELETE", `/api/tenants/${tid}/grants/${gid}`);
}

/** Once and standing map to the hub approval scopes. Deny is the reject route. */
export async function resolveApproval(
  transport: Transport,
  tenantId: string,
  approvalId: string,
  decision: "once" | "always" | "deny",
): Promise<void> {
  const tid = enc(requireTenantId(tenantId));
  const aid = enc(requireId(approvalId, "Approval id"));
  if (decision === "deny") {
    await transport.fetch("POST", `/api/tenants/${tid}/approvals/${aid}/reject`, {
      scope: "once",
    });
    return;
  }
  await transport.fetch("POST", `/api/tenants/${tid}/approvals/${aid}/approve`, {
    scope: decision,
  });
}

function isAuthDenied(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 403;
}

function isSessionDead(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 401;
}

async function tolerateSection<T>(work: Promise<T>, fallback: T): Promise<{ value: T; denied: boolean }> {
  try {
    return { value: await work, denied: false };
  } catch (cause) {
    if (isSessionDead(cause)) throw cause;
    if (isAuthDenied(cause)) return { value: fallback, denied: true };
    if (cause instanceof ApiError) return { value: fallback, denied: false };
    throw cause;
  }
}

export async function listGrants(transport: Transport, tenantId: string): Promise<HubGrant[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubGrant>(transport, `/api/tenants/${tid}/grants`);
}

export async function listApprovals(transport: Transport, tenantId: string): Promise<HubApproval[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubApproval>(transport, `/api/tenants/${tid}/approvals`);
}

export async function listRuns(transport: Transport, tenantId: string): Promise<HubRun[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubRun>(transport, `/api/tenants/${tid}/workflows/runs`);
}

/** Only what the gate needs; approvals, runs and access rules are read by the pages that show them. */
export async function loadPortal(transport: Transport, access: MemberAccess, hasPack: CheckPackLookup): Promise<PortalSnapshot> {
  const { workspace, workspaces, invitations } = access;
  const tenantId = requireTenantId(workspace.tenantId);
  const tid = enc(tenantId);
  const tenantFallback: TenantBody = { id: tenantId, name: "", slug: WORKSPACE_SLUG };
  const [tenant, credentials] = await Promise.all([
    tolerateSection(transport.fetch<TenantBody>("GET", `/api/tenants/${tid}`), tenantFallback),
    tolerateSection(listAll<HubCredential>(transport, `/api/tenants/${tid}/credentials`), []),
  ]);
  return {
    workspace,
    tenantName: tenant.value.name,
    workspaces,
    invitations,
    repos: tenant.denied ? [] : await withPackPointers(reposFromConfig(tenant.value.config), hasPack),
    config: appConfig(tenant.value.config),
    configVersion: configFingerprint(tenant.value.config),
    credentials: credentials.value,
    denied: {
      repos: tenant.denied,
      credentials: credentials.denied,
    },
  };
}

export function portalConnected(snapshot: PortalSnapshot): boolean {
  return hasActiveGithubCredential(snapshot.credentials);
}

export type QueueState =
  | "needs-decision"
  | "awaiting-review"
  | "needs-author-update"
  | "blocked"
  | "ready"
  | "stale"
  | "new";

export const QUEUE_STATE_LABEL: Record<QueueState, string> = {
  "needs-decision": "Needs decision",
  "awaiting-review": "Awaiting review",
  "needs-author-update": "Needs author update",
  blocked: "Blocked",
  ready: "Ready · monitoring",
  stale: "Stale — rechecking",
  new: "Not triaged yet",
};

export type CiState = "success" | "failure" | "pending" | "none";

const CI_STATES: readonly unknown[] = ["success", "failure", "pending", "none"] satisfies CiState[];

function isCiState(value: unknown): value is CiState {
  return CI_STATES.includes(value);
}

/** Whether a pull request should merge now; shown in the portal, never posted to GitHub. */
export type MergeVerdict = { verdict: "ready" | "not-recommended"; score: number | null; threshold: number; reasons: string[] };

/** Null for a verdict rendered before it carried a merge verdict. */
function mergeVerdict(merge: VerdictDetail["merge"]): MergeVerdict | null {
  const verdict = merge?.verdict;
  if (!merge || (verdict !== "ready" && verdict !== "not-recommended")) return null;
  return { verdict, score: merge.score, threshold: merge.threshold, reasons: merge.reasons };
}

export type PrItem = {
  key: string;
  repo: string;
  number: number | null;
  title: string | null;
  author: string | null;
  /** Who the author is to the repository, known once the open pull requests have loaded; null when GitHub does not say. */
  authorKind: AuthorKind | null;
  draft: boolean | null;
  mergeable: boolean | null;
  state: QueueState;
  priority: string | null;
  owner: string | null;
  nextAction: string | null;
  confidence: number | null;
  merge: MergeVerdict | null;
  evidence: string[];
  checks: CheckResult[];
  labels: string[];
  comment: string | null;
  sha: string | null;
  /** The head commit the verdict judged, which cited lines link into; null for a verdict recorded before it was stamped. */
  verdictSha: string | null;
  degraded: string | null;
  needsHuman: boolean;
  closed: boolean;
  pendingApprovalId: string | null;
  runId: string | null;
  waitingSince: string | null;
  /** GitHub's last update to the pull request, known once the open pull requests have loaded. */
  updatedAt: string | null;
  /** The CI state the verdict saw. */
  ci: CiState | null;
  /** The current head, known once the open pull requests have loaded. */
  headSha: string | null;
  /** When the newest run triggered by author activity started; see `AUTHOR_ACTIVITY`. */
  activityAt: string | null;
  /** The verdict saw the author push, comment or reply in a review after the newest standing request for changes. */
  reviewAnswered: boolean;
  /** The verdict's reply is on GitHub: the run's mirror step wrote non-empty feedback, or this portal sent it (see `useQueueItems`). */
  posted: boolean;
  /** A pr-triage run for this pull request has started and has not rendered its verdict yet. */
  running: boolean;
  /** Why the latest pr-triage run for this pull request ended without a verdict, when it did. */
  failure: RunFailure | null;
  actions: SuggestedAction[];
  href: string;
};

// The portal reads verdict JSON and does not import the workflow package, so this keeps only the fields it uses.
/** `held` waits for a maintainer's approval; `status` is how running it last ended, and `error` why it did not write. */
export type SuggestedAction = { id: string; branch: DoBranch; index: number; effectId: string; kind: ActionKind; reason: string; target: Record<string, unknown>; held: boolean; status?: DoStatus; error?: string };

const DO_STATUSES = ["done", "satisfied", "failed", "skipped"] as const;

type DoStatus = (typeof DO_STATUSES)[number];

function isDoStatus(value: unknown): value is DoStatus {
  return (DO_STATUSES as readonly unknown[]).includes(value);
}

const DO_BRANCHES = ["yes", "no", "unsure", "always"] as const;

export type DoBranch = (typeof DO_BRANCHES)[number];

function isActionKind(value: unknown): value is ActionKind {
  return (ACTION_KINDS as readonly unknown[]).includes(value);
}

function isDoBranch(value: unknown): value is DoBranch {
  return (DO_BRANCHES as readonly unknown[]).includes(value);
}

function suggestedActions(actions: NonNullable<VerdictDetail["actions"]>): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  for (const { id, branch, index, effectId, kind, reason, target, skipped, held, status, error } of actions) {
    if (skipped || reason === undefined || !isActionKind(kind) || !target) continue;
    // A verdict from before Dos by reference names none the hub can run.
    if (!isDoBranch(branch) || index === undefined || effectId === undefined) continue;
    out.push({ id, branch, index, effectId, kind, reason, target, held: held === true, ...(isDoStatus(status) && { status }), ...(error !== undefined && { error }) });
  }
  return out;
}

export type RunFailure = "failed" | "cancelled" | "stuck";

export type CheckResult = {
  check: string;
  /** Null for a verdict the hub recorded before it kept the checks' detail. */
  kind: "machine" | "model" | null;
  result: "pass" | "fail" | "unconfirmed";
  reason: string | null;
  evidence: string[];
  /** Null for a verdict made before checks carried output. */
  output: CheckOutput | null;
  /** Decides an action's branch; shown as matched or not, never as a failure. */
  gate: boolean;
};

function isCheckResult(value: unknown): value is CheckResult["result"] {
  return value === "pass" || value === "fail" || value === "unconfirmed";
}

function checkResults(checks: NonNullable<VerdictDetail["checks"]>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const { check, kind, result, reason, evidence, output, gate } of checks) {
    // A verdict from before a check was removed may still list it.
    if (RETIRED_CHECK_IDS.has(check) || (kind !== "machine" && kind !== "model") || !isCheckResult(result)) continue;
    out.push({ check, kind, result, reason: reason ?? null, evidence: evidence ?? [], output: parseCheckOutput(output) ?? null, gate: gate === true });
  }
  return out;
}

/** A verdict recorded before the hub kept its detail still has each check's result. */
function recordedChecks(checks: PullVerdict["checks"]): CheckResult[] {
  return checks.flatMap(({ check, result }) => (isCheckResult(result) && !RETIRED_CHECK_IDS.has(check) ? [{ check, kind: null, result, reason: null, evidence: [], output: null, gate: false }] : []));
}

function canonicalPrHref(repo: string, number: number): string {
  const [owner, name] = repo.split("/");
  return `/triage/pr/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${number}`;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

const TRIAGE_TO_QUEUE: Record<string, QueueState> = {
  "needs-decision": "needs-decision",
  "awaiting-review": "awaiting-review",
  "needs-author-update": "needs-author-update",
  blocked: "blocked",
  "ready-monitoring": "ready",
  "stale-unknown": "stale",
};

function isGithubWriteApproval(approval: HubApproval): boolean {
  const tool = approval.toolDefinition.name;
  return tool === "github_mirror"
    || tool === "github_mirror_auto"
    || tool === "github_create_review"
    || tool === "github_create_issue_comment"
    || tool === "github_merge_pr";
}

/** A stuck run is a failure, not running, so its Dos stay enabled: running them again is the way out. */
function failureOf(run: PullRun | null): RunFailure | null {
  return run === null || run.status === "running" || run.status === "unknown" ? null : run.status;
}

/** A run the hub has not read yet may be going, so it holds writes like one that is. */
function isRunning(run: PullRun | null): boolean {
  return run?.status === "running" || run?.status === "unknown";
}

function verdictItem(pull: PullTriage, verdict: PullVerdict): PrItem {
  const key = `${pull.repo}#${pull.number}`;
  const detail: VerdictDetail = verdict.detail ?? {};
  const facts: NonNullable<VerdictDetail["facts"]> = detail.facts ?? {};
  return {
    key,
    repo: pull.repo,
    number: pull.number,
    title: facts.title || null,
    author: facts.author || null,
    authorKind: null,
    draft: facts.draft ?? null,
    mergeable: facts.mergeable ?? null,
    state: TRIAGE_TO_QUEUE[verdict.state] ?? "stale",
    priority: detail.priority || null,
    owner: detail.owner || null,
    nextAction: detail.nextAction || null,
    confidence: detail.score ?? null,
    merge: mergeVerdict(detail.merge),
    evidence: detail.evidence ?? [],
    checks: verdict.detail === null ? recordedChecks(verdict.checks) : checkResults(detail.checks ?? []),
    labels: detail.labels ?? [],
    comment: detail.feedback ?? null,
    sha: verdict.headSha,
    verdictSha: detail.headSha ?? null,
    degraded: verdict.degraded,
    needsHuman: verdict.humanGated,
    closed: false,
    pendingApprovalId: null,
    runId: verdict.runId,
    waitingSince: verdict.at,
    updatedAt: null,
    ci: isCiState(facts.checks) ? facts.checks : null,
    headSha: null,
    activityAt: pull.activityAt,
    reviewAnswered: facts.reviewAnswered === true,
    posted: verdict.commented,
    running: isRunning(pull.run),
    failure: failureOf(pull.run),
    actions: suggestedActions(detail.actions ?? []),
    href: canonicalPrHref(pull.repo, pull.number),
  };
}

/**
 * Queue projection from the hub's latest verdict of each pull request. Pending github_mirror approvals only
 * overlay needs-human; they never decide the verdict. With the open pull requests, unseen ones join as "new"
 * and verdicts of closed ones stop needing a human.
 */
export function projectQueue(pulls: PullTriage[], approvals: HubApproval[], openPulls: OpenPulls | undefined): PrItem[] {
  const items = new Map<string, PrItem>();
  const triage = new Map(pulls.map((pull) => [`${pull.repo}#${pull.number}`, pull]));
  for (const pull of pulls) {
    if (pull.verdict) items.set(`${pull.repo}#${pull.number}`, verdictItem(pull, pull.verdict));
  }
  for (const approval of approvals) {
    if (!isGithubWriteApproval(approval) || approval.status !== "pending") continue;
    const args = approval.toolArguments;
    const item = items.get(`${args.repo}#${args.number}`);
    if (!item) continue;
    items.set(item.key, {
      ...item,
      needsHuman: true,
      pendingApprovalId: approval.id,
      waitingSince: approval.createdAt ?? item.waitingSince,
    });
  }
  if (openPulls) joinOpenPulls(items, openPulls, triage);
  return [...items.values()];
}

function joinOpenPulls(items: Map<string, PrItem>, openPulls: OpenPulls, triage: Map<string, PullTriage>): void {
  for (const { repo, prs, error } of openPulls.repos) {
    if (error) continue;
    const open = new Set(prs.map((pr) => `${repo}#${pr.number}`));
    for (const item of items.values()) {
      if (item.repo === repo && !open.has(item.key)) items.set(item.key, { ...item, needsHuman: false, closed: true });
    }
    for (const pr of prs) {
      const key = `${repo}#${pr.number}`;
      const known = items.get(key);
      if (known) {
        // A verdict recorded before the hub kept its facts takes the pull request's from GitHub.
        items.set(key, { ...known, title: known.title ?? pr.title, author: known.author ?? pr.author, draft: known.draft ?? pr.draft, authorKind: pr.authorKind ?? null, updatedAt: pr.updatedAt, headSha: pr.sha });
        continue;
      }
      const pull = triage.get(key);
      items.set(key, {
        key,
        repo,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        authorKind: pr.authorKind ?? null,
        draft: pr.draft,
        mergeable: null,
        state: "new",
        priority: null,
        owner: null,
        nextAction: null,
        confidence: null,
        merge: null,
        evidence: [],
        checks: [],
        labels: pr.labels,
        comment: null,
        sha: pr.sha,
        verdictSha: null,
        degraded: null,
        needsHuman: false,
        closed: false,
        pendingApprovalId: null,
        runId: null,
        waitingSince: pr.updatedAt,
        updatedAt: pr.updatedAt,
        ci: null,
        headSha: pr.sha,
        activityAt: pull?.activityAt ?? null,
        reviewAnswered: false,
        posted: false,
        running: isRunning(pull?.run ?? null),
        failure: failureOf(pull?.run ?? null),
        actions: [],
        href: canonicalPrHref(repo, pr.number),
      });
    }
  }
}

