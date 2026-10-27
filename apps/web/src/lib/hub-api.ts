import {
  ApiError,
  type Transport,
} from "@intx/hub-client";
import { asRecord, asRepo, compare } from "@corbits/common";
import { GITHUB_HOOK_HEADERS, xHubHookMetadata } from "@corbits/common/hook-metadata";
import type { ApprovalResponse, CredentialResponse, GrantResponse, PrincipalResponse, RoleResponse } from "@intx/types";
import { AuditLog, BacklogStarted, CodeReviewPlace, PolicyExported, TRIAGE_LISTENERS, PolicyFileRead, PolicyRead, PolicyUpgrades, readCheckPack, repoPolicy, repoSourceOf, checkPackName, CODE_REVIEW_PROVIDERS, currentRows, parseCheckOutput, ACTION_KINDS, RETIRED_CHECK_IDS, DeployedVersions, InviteRoles, InviteSent, SessionList, TriageStats, TriageVerdicts, type ActionKind, type AuthorKind, type CheckOutput, type CheckPack, type MergeRisk, type PolicyFileStatus, type RepoCheckFlags, type RepoPolicy, type RepoSource, type VerdictDetail, type VerdictWord } from "@corbits/triage-contracts";
import { createGrantBody, type CreateGrantInput } from "./grant-actions.ts";

const WORKSPACE_SLUG =
  (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_WORKSPACE_SLUG?.trim() || "corbits-triage";
const GITHUB_PROVIDER = "github";
const GITHUB_PROVIDER_PLUGIN = "http";
export const GITHUB_CREDENTIAL_NAME = "github";
export const GITHUB_HOOK_CREDENTIAL_NAME = "github-hook";
/** The App's private key: the hub moves it here off the GitHub App credential, which then holds an installation token. */
export const GITHUB_APP_KEY_CREDENTIAL_NAME = "github-app";
export const INFERENCE_PROVIDER = "corbits-system-one";
const INFERENCE_PROVIDER_PLUGIN = "corbits-system-one";
export const INFERENCE_CREDENTIAL_NAME = "corbits-system-one";
/** Catalog model the triage workflows declare; its offering carries the provider's own model name. */
export const DECISION_MODEL_ALIAS = "decision";
export const ANTHROPIC_PROVIDER = "anthropic";
export const ANTHROPIC_API = "https://api.anthropic.com";
export const ANTHROPIC_CREDENTIAL_NAME = CODE_REVIEW_PROVIDERS.anthropic.credential;

function githubProviderApiBaseUrl(
  env: Record<string, string | undefined> = (import.meta as { env?: Record<string, string | undefined> }).env ?? {},
): string {
  const raw = env["VITE_GITHUB_API_ORIGIN"]?.trim();
  if (!raw) return "https://api.github.com";
  return raw.replace(/\/+$/, "");
}

type Workspace = {
  tenantId: string;
  principalId: string;
  userId: string;
};

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
type WorkspaceAccess = MemberAccess | InvitedAccess | { kind: "none" };

type Page<T> = { data: T[]; nextCursor: string | null };

export type RepoRecord = {
  name: string;
  connected: boolean;
  source: RepoSource;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  enabled?: boolean;
  checks?: RepoCheckFlags;
  checkPack?: { name: string; id?: string };
};

export function githubAppInstallUrl(slug: string): string {
  const clean = slug.trim();
  if (!clean) throw new Error("GitHub App slug is required.");
  return `https://github.com/apps/${encodeURIComponent(clean)}/installations/new`;
}

export function isActiveCredential(credential: HubCredential): boolean {
  return typeof credential.status === "string" && credential.status.toLowerCase() === "active";
}

export function activeGithubCredential(credentials: HubCredential[]): HubCredential | undefined {
  return credentials.find((item) => item.name === GITHUB_CREDENTIAL_NAME && isActiveCredential(item));
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

/** A sign-in account backs every person, and gives them an email; system senders such as the GitHub bridge have none. */
export function isPerson(principal: HubPrincipal): boolean {
  return principal.email !== undefined;
}
export type HubRole = typeof RoleResponse.infer;
export type HubApproval = typeof ApprovalResponse.infer;

type SectionDenied = {
  repos: boolean;
  credentials: boolean;
  models: boolean;
};

export type PortalSnapshot = {
  workspace: Workspace;
  tenantName: string;
  workspaces: WorkspaceOption[];
  invitations: WorkspaceOption[];
  repos: RepoRecord[];
  config?: AppConfig;
  configVersion?: string;
  credentials: HubCredential[];
  decisionModel?: Inference;
  /** Absent when the hub refused or failed to say where code review runs. */
  codeReviewPlace?: CodeReviewPlace["provisioner"];
  codeReviewPlaces?: CodeReviewPlace["places"];
  /** Set when the hub failed to list the keys for a reason other than access, so an empty `credentials` does not mean no key is stored. */
  credentialsError?: string;
  /** Set when the hub failed to say where code review runs for a reason other than access. */
  codeReviewPlaceError?: string;
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

export function enc(value: string): string {
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
  const clean = asRepo(repo);
  if (!clean) throw new Error("Repository must be owner/name.");
  return clean;
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

export async function listAll<T>(transport: Transport, path: string): Promise<T[]> {
  return listPages<T>(transport, path, function readPage(raw) {
    if (Array.isArray(raw)) return { rows: raw as T[], next: null };
    const page = raw as Page<T> | undefined;
    return { rows: page?.data, next: page?.nextCursor ?? null };
  });
}

export type CatalogRow = { id: string; name?: string; canonicalName?: string; baseURL?: string; credentialId?: string | null; modelId?: string; providerId?: string; quirks?: Record<string, unknown> | null };

type CatalogRows = "providers" | "models" | "offerings";

export type Catalog = Record<CatalogRows, CatalogRow[]>;

export function catalogPath(tenantId: string, rows: CatalogRows): string {
  return `/api/tenants/${enc(tenantId)}/catalog/${rows}`;
}

export async function listCatalog(transport: Transport, tenantId: string): Promise<Catalog> {
  const [providers, models, offerings] = await Promise.all([
    listAll<CatalogRow>(transport, catalogPath(tenantId, "providers")),
    listAll<CatalogRow>(transport, catalogPath(tenantId, "models")),
    listAll<CatalogRow>(transport, catalogPath(tenantId, "offerings")),
  ]);
  return { providers, models, offerings };
}

/** The saved decision model: its catalog provider's endpoint and the model its decision offering names, while the provider's key is active. */
function decisionModelOf({ providers, models, offerings }: Catalog, credentials: readonly HubCredential[]): Inference | undefined {
  const provider = providers.find((row) => row.name === INFERENCE_PROVIDER);
  const decision = models.find((row) => row.canonicalName === DECISION_MODEL_ALIAS);
  if (!provider?.baseURL || !decision) return undefined;
  if (!credentials.some((credential) => credential.id === provider.credentialId && isActiveCredential(credential))) return undefined;
  const model = offerings.find((row) => row.providerId === provider.id && row.modelId === decision.id)?.quirks?.["model"];
  return typeof model === "string" ? { endpoint: provider.baseURL, model } : undefined;
}

const CONFIG_KEY = "corbitsTriage";

export type Inference = { endpoint: string; model: string };

export type AppConfig = {
  repos?: unknown[];
  allowlist?: Record<string, string[]>;
  labelMap?: Record<string, string>;
  allowlistImport?: {
    at: string;
    organizationRuns: Array<{ repo: string; organization: string; count: number; runId: string }>;
  };
  rev?: number;
};

function appConfig(config: unknown): AppConfig {
  if (!config || typeof config !== "object") return {};
  const ns = (config as Record<string, unknown>)[CONFIG_KEY];
  return ns && typeof ns === "object" ? (ns as AppConfig) : {};
}

function sortedKeys(_key: string, value: unknown): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => compare(a, b)))
    : value;
}

function configFingerprint(config: unknown): string {
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
  return Array.isArray(repos) ? repoRecords(repos) : [];
}

function repoRecords(repos: unknown[]): RepoRecord[] {
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
    const source = repoSourceOf((row as { source?: unknown }).source);
    parsed.push({
      name,
      connected,
      source,
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

/**
 * `automatic` is what Triage may do on its own in the repository; `decide` the kinds the policy file's `decide` names;
 * `mergeRisks` what its automatic approve or merge can let in.
 */
type PolicyKinds = { automatic?: ActionKind[]; decide?: ActionKind[]; mergeRisks?: MergeRisk[] };
export type StoredCheckPack = { kind: "pack"; id: string; version: number; pack: CheckPack } & PolicyKinds;
/** The repository's artifact holds something that is not a check pack; a save replaces it in place. */
type CorruptCheckPack = { kind: "corrupt"; id: string; version: number; reason: string };
/** Read from the repository's policy file, which only a change to the file edits. */
type FileCheckPack = { kind: "file"; path: string; pack: CheckPack } & PolicyKinds;
/** The repository's policy file is refused, so triage runs nothing until it is fixed. */
type InvalidPolicyFile = { kind: "invalid"; path: string; reason: string };
export type CheckPackArtifact = StoredCheckPack | CorruptCheckPack | FileCheckPack | InvalidPolicyFile;

export async function loadRepoCheckPack(transport: Transport, tenantId: string, repo: string, source: RepoSource): Promise<CheckPackArtifact | null> {
  const clean = validateRepo(repo);
  const read = PolicyRead.assert(await transport.fetch<unknown>("GET", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}/policy?repo=${enc(clean)}&source=${source}`));
  if (read.status === "missing") return null;
  if (read.status === "corrupt") return { kind: "corrupt", ...read.repo, reason: read.reason };
  if (read.status === "invalid") return { kind: "invalid", path: read.path, reason: read.reason };
  const { repo: stored, file } = read.source;
  const pack = readCheckPack(read.pack, clean);
  const kinds = { automatic: read.automatic, decide: read.decide, mergeRisks: read.mergeRisks };
  if (file) return { kind: "file", path: file.path, pack, ...kinds };
  if (!stored) throw new Error(`The hub named no policy ${clean} was read from.`);
  return { kind: "pack", ...stored, pack, ...kinds };
}

export type CheckPackLookup = (record: RepoRecord) => Promise<boolean>;

async function withPackPointers(repos: RepoRecord[], hasPack: CheckPackLookup): Promise<RepoRecord[]> {
  return Promise.all(repos.map(async function linkExistingPack(repo) {
    if (repo.checkPack?.name?.trim()) return repo;
    return (await hasPack(repo)) ? { ...repo, checkPack: { name: checkPackName(repo.name, repo.source) } } : repo;
  }));
}

export async function loadRepoPolicy(transport: Transport, tenantId: string, repo: string, source: RepoSource): Promise<RepoPolicy> {
  const tid = enc(requireTenantId(tenantId));
  const tenant = await transport.fetch<TenantBody>("GET", `/api/tenants/${tid}`);
  const row = reposFromConfig(tenant.config).find((item) => item.name === repo && item.source === source);
  return repoPolicy(row);
}

export async function saveRepoSettings(
  transport: Transport,
  tenantId: string,
  repo: string,
  source: RepoSource,
  settings: Pick<RepoPolicy, "enabled">,
  packId: string | null,
): Promise<void> {
  const clean = validateRepo(repo);
  const { enabled } = settings;
  /** So triage reads the same artifact. */
  function withSettings(row: RepoRecord): RepoRecord {
    return { ...row, enabled, ...(packId !== null && { checkPack: { name: checkPackName(clean, source), id: packId } }) };
  }
  function isRepo(row: unknown): boolean {
    return rowName(row) === clean && repoSourceOf((row as { source?: unknown }).source) === source;
  }
  await patchAppConfig(transport, tenantId, function applySettings(current) {
    const repos = current.repos ?? [];
    if (!repos.some(isRepo)) throw new Error("Repository not found.");
    return { ...current, repos: repos.map((row) => (isRepo(row) ? withSettings(row as RepoRecord) : row)) };
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
  function isOwn(entry: Membership): boolean {
    return entry.tenantSlug === own;
  }
  function isExtra(entry: Membership): boolean {
    return Boolean(entry.tenantSlug?.startsWith(`${own}-`));
  }
  const open = active.find((entry) => entry.tenantId === chosen) ?? active.find((entry) => !isOwn(entry) && !isExtra(entry)) ?? active.find(isOwn) ?? active[0];
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

async function resolveWorkspace(transport: Transport, chosen: string | null): Promise<WorkspaceAccess> {
  const user = await transport.fetch<HubMe | null>("GET", "/api/me");
  if (!user?.id) throw new Error("The hub did not return the signed-in user.");
  return chooseWorkspace(await listAll<Membership>(transport, "/api/me/principals"), user, chosen);
}

export async function inviteRoles(transport: Transport, tenantId: string): Promise<InviteRoles> {
  return InviteRoles.assert(await transport.fetch<unknown>("GET", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}`));
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

export async function markEmailVerified(transport: Transport, tenantId: string, principalId: string): Promise<void> {
  await transport.fetch("POST", `/api/integrations/invitations/${enc(requireTenantId(tenantId))}/${enc(requireId(principalId, "Principal id"))}/verify`, {});
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
function workspaceSlugFor(user: HubMe): string {
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

/** The random slug suffix lets one user make many workspaces. */
export async function createExtraWorkspace(transport: Transport, name: string): Promise<string> {
  const user = await transport.fetch<HubMe>("GET", "/api/me");
  const slug = `${workspaceSlugFor(user)}-${crypto.randomUUID().slice(0, 6)}`;
  const created = await transport.fetch<TenantBody>("POST", "/api/tenants", { name, slug });
  return created.id;
}

/** Opens a workspace the user is active in, else reports their invitations; only a user with neither gets a workspace of their own. */
export async function ensureWorkspace(transport: Transport, chosen: string | null): Promise<MemberAccess | InvitedAccess> {
  const existing = await resolveWorkspace(transport, chosen);
  if (existing.kind !== "none") return existing;
  return createWorkspace(transport);
}

export function legacyHookCredentials(credentials: HubCredential[]): HubCredential[] {
  return credentials.filter((row) => row.name.startsWith(`${GITHUB_HOOK_CREDENTIAL_NAME}:`));
}

function credentialIdempotencyKey(providerId: string, name: string): string {
  return `${providerId}:${name}`;
}

function pickProvider(providers: ProviderBody[], name: string): ProviderBody | undefined {
  const matches = providers.filter((row) => row.name === name);
  if (matches.length > 1) {
    console.warn(`hub-api: ${matches.length} ${name} providers; picking deterministically by id.`);
  }
  return [...matches].sort((a, b) => compare(a.id, b.id))[0];
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

/**
 * Converges the app-level hook credential GitHub posts to. The secret is the
 * GitHub webhook signing secret (never the GitHub API credential); the
 * metadata names the X-Hub-Signature verifier, its headers and the GitHub
 * listener. Returns the credential id for the hook URL.
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
  const metadata = xHubHookMetadata(TRIAGE_LISTENERS.github, GITHUB_HOOK_HEADERS);
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

type ProviderSpec = { name: string; plugin: string; apiBaseUrl: string };

async function ensureCredentialProvider(transport: Transport, tenantId: string, spec: ProviderSpec): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const body = { plugin: spec.plugin, apiBaseUrl: spec.apiBaseUrl };
  async function converge(existing: ProviderBody): Promise<string> {
    if (existing.plugin !== spec.plugin || existing.apiBaseUrl !== spec.apiBaseUrl) {
      await transport.fetch("PATCH", `/api/tenants/${tid}/providers/${enc(existing.id)}`, body);
    }
    return existing.id;
  }
  const existing = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), spec.name);
  if (existing) return converge(existing);
  try {
    const created = await transport.fetch<ProviderBody>("POST", `/api/tenants/${tid}/providers`, { name: spec.name, ...body });
    return created.id;
  } catch (cause) {
    if (!(cause instanceof ApiError && cause.status === 409)) throw cause;
    const raced = pickProvider(await listAll<ProviderBody>(transport, `/api/tenants/${tid}/providers`), spec.name);
    if (raced) return converge(raced);
    throw cause;
  }
}

/** Stores an API key in the vault under its provider, replacing the secret of the one already stored; returns its id. */
async function writeApiKey(
  transport: Transport,
  tenantId: string,
  input: { providerId: string; name: string; secret: string; what: string },
): Promise<string> {
  const tid = enc(requireTenantId(tenantId));
  const { providerId, name, secret } = input;
  try {
    const created = await transport.fetch<HubCredential>("POST", `/api/tenants/${tid}/credentials`, {
      providerId,
      name,
      type: "api_key",
      secret,
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
      throw new Error(`The ${input.what} is ${label} — save a new secret.`);
    }
    const patch: Record<string, unknown> = { secret };
    if (REACTIVATABLE_CREDENTIAL_STATUSES.has(status)) patch.status = "active";
    await transport.fetch("PATCH", `/api/tenants/${tid}/credentials/${enc(existing.id)}`, patch);
    return existing.id;
  }
}

/** Stores the decision model's key in the vault; returns the checked endpoint and model with the key's id. */
export async function saveInferenceKey(
  transport: Transport,
  tenantId: string,
  input: { endpoint: string; model: string; secret: string },
): Promise<Inference & { credentialId: string }> {
  const endpoint = requireHttpsUrl(input.endpoint, "Endpoint");
  const model = requireContent(input.model, "Model");
  if (!input.secret.trim()) throw new Error("Secret is required.");
  const secret = requireSecret(input.secret);
  const providerId = await ensureCredentialProvider(transport, tenantId, { name: INFERENCE_PROVIDER, plugin: INFERENCE_PROVIDER_PLUGIN, apiBaseUrl: endpoint });
  const credentialId = await writeApiKey(transport, tenantId, {
    providerId,
    name: INFERENCE_CREDENTIAL_NAME,
    secret,
    what: "inference secret",
  });
  return { endpoint, model, credentialId };
}

export async function saveAnthropicKey(transport: Transport, tenantId: string, input: string): Promise<void> {
  const secret = requireSecret(input);
  const providerId = await ensureCredentialProvider(transport, tenantId, { name: ANTHROPIC_PROVIDER, plugin: ANTHROPIC_PROVIDER, apiBaseUrl: ANTHROPIC_API });
  await writeApiKey(transport, tenantId, { providerId, name: ANTHROPIC_CREDENTIAL_NAME, secret, what: "Anthropic key" });
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

/** A live deployment with the versions its frozen closure pins; `package` is null when the closure does not name its workflow. */
export type DeployedWorkflow = DeployedVersions["deployments"][number];

export async function listDeployedWorkflows(transport: Transport, tenantId: string): Promise<DeployedWorkflow[]> {
  const tid = enc(requireTenantId(tenantId));
  return DeployedVersions.assert(await transport.fetch<unknown>("GET", `/api/integrations/workflow-versions/${tid}`)).deployments;
}

export function currentDeployment(deployments: readonly DeployedWorkflow[], workflow: string): DeployedWorkflow | undefined {
  return deployments.find((deployment) => deployment.workflow === workflow && !deployment.cancelling);
}

export const WAITING_FOR_WORKFLOW = "Waiting for the workflow to be ready…";

// A deployment answers 409 `deployment_not_ready` until it records its credential resolution, seconds after it is deployed.
const NOT_READY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000];

function isDeploymentNotReady(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 409 && cause.code === "deployment_not_ready";
}

export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export async function startBacklogTriage(transport: Transport, tenantId: string, repo: string): Promise<void> {
  const clean = validateRepo(repo);
  BacklogStarted.assert(await transport.fetch<unknown>("POST", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}/backlog`, { repo: clean }));
}

export async function loadPolicyFile(transport: Transport, tenantId: string, repo: string): Promise<PolicyFileStatus | null> {
  const clean = validateRepo(repo);
  return PolicyFileRead.assert(await transport.fetch<unknown>("GET", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}/policy/file?repo=${enc(clean)}`)).file;
}

export async function exportPolicyFile(transport: Transport, tenantId: string, repo: string): Promise<PolicyExported> {
  const clean = validateRepo(repo);
  return PolicyExported.assert(await transport.fetch<unknown>("POST", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}/policy/export`, { repo: clean }));
}

export async function loadPolicyUpgrades(transport: Transport, tenantId: string): Promise<PolicyUpgrades["repos"]> {
  return PolicyUpgrades.assert(await transport.fetch<unknown>("GET", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}/policy/upgrades`)).repos;
}

/** Archiving hides an artifact and keeps it restorable. */
export async function archiveArtifact(transport: Transport, tenantId: string, id: string): Promise<void> {
  await transport.fetch<unknown>("POST", `/api/tenants/${enc(requireTenantId(tenantId))}/artifacts/${enc(id)}/archive`);
}

export async function triagePullRequest(transport: Transport, tenantId: string, repo: string, number: number): Promise<void> {
  const clean = validateRepo(repo);
  if (!Number.isInteger(number) || number < 1) throw new Error("Pull request number must be a positive integer.");
  await transport.fetch("POST", `/api/integrations/github-triage/${enc(requireTenantId(tenantId))}`, { repo: clean, number });
}

export type CodeReviewComment = { path: string; start: number; end: number; title: string; body: string; priority?: number; quoted?: string; unverified?: true };
export type CodeReviewRun = {
  status: "running" | "completed" | "failed";
  headSha: string;
  startedAt: string;
  summary?: string;
  comments?: CodeReviewComment[];
  budgetExhausted?: boolean;
  /** Set when the diff was cut to its first `lines` of `of` for size, with the files it cut part-way or left out. */
  cut?: { lines: number; of: number; unread?: string[] };
};

/**
 * The newest review, and the newest finished one, whose findings stay shown while a newer review runs; `carriedTo` is the
 * asked head when its diff is the one the finished review read, so that review stands for it.
 */
export type CodeReviews = { review: CodeReviewRun | null; completed: CodeReviewRun | null; carriedTo: string | null };

export async function latestCodeReview(transport: Transport, tenantId: string, repo: Pick<RepoRecord, "name" | "source">, number: number, head: string | null): Promise<CodeReviews> {
  const query = new URLSearchParams({ repo: validateRepo(repo.name), source: repo.source, number: String(number), ...(head !== null && { head }) });
  return transport.fetch<CodeReviews>("GET", `/api/integrations/code-review/${enc(requireTenantId(tenantId))}?${query}`);
}

export async function reviewAgain(transport: Transport, tenantId: string, repo: Pick<RepoRecord, "name" | "source">, number: number): Promise<void> {
  await transport.fetch("POST", `/api/integrations/code-review/${enc(requireTenantId(tenantId))}/run`, { repo: validateRepo(repo.name), source: repo.source, number });
}

export type OpenPulls = {
  repos: Array<{
    repo: string;
    /** The host the pull requests are on; absent from a hub that predates other hosts, which listed GitHub only. */
    source?: RepoSource;
    prs: Array<{ number: number; title: string; author: string | null; authorKind?: AuthorKind; byTriage?: true; draft: boolean; sha: string; updatedAt: string; labels: string[]; url?: string | null }>;
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
  | { action: "code-review"; repo: string; number: number; headSha: string }
  | { action: "merge"; repo: string; number: number; headSha: string }
  | { action: "close"; repo: string; number: number; labels: string[]; comment: string };

/** The hub answers a reply with the GitHub comment it wrote, and a code review send with whether it was already there. */
export type PrGithubWriteResult = { commentId: number | null; alreadySent?: true };

export async function githubPrAction(transport: Transport, tenantId: string, input: PrGithubWriteInput): Promise<PrGithubWriteResult> {
  const repo = validateRepo(input.repo);
  if (!Number.isInteger(input.number) || input.number < 1) throw new Error("Pull request number must be a positive integer.");
  if ((input.action === "comment" || input.action === "reply") && !input.body.trim()) throw new Error("Comment must not be empty.");
  if (input.action === "review" && input.event !== "APPROVE" && !input.body.trim()) {
    throw new Error("Review body must not be empty.");
  }
  const result = asRecord(await transport.fetch<unknown>("POST", `/api/integrations/github-actions/${enc(requireTenantId(tenantId))}`, { ...input, repo })) ?? {};
  return { commentId: typeof result.commentId === "number" ? result.commentId : null, ...(result.sent === false ? { alreadySent: true as const } : {}) };
}

/** Names one held Do by the run whose verdict holds it; the hub looks the Do up and mails the deployment to run it. */
export type HeldDoRef = { runId: string; repo: string; number: number; effectId: string; kind: ActionKind };

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

export async function loadAuditLog(transport: Transport, tenantId: string, repo: string | null, limit: number): Promise<AuditLog> {
  const scope = repo === null ? "" : `&repo=${enc(validateRepo(repo))}`;
  return AuditLog.assert(await transport.fetch<unknown>("GET", `/api/integrations/audit/${enc(requireTenantId(tenantId))}?limit=${limit}${scope}`));
}

export type CheckChange = { check: string; from: string | null; to: string | null };

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

export type PullVerdict = NonNullable<PullTriage["verdict"]>;

type PullRun = NonNullable<PullTriage["run"]>;

export async function loadTriageVerdicts(transport: Transport, tenantId: string, pull?: { repo: string; number: number }): Promise<TriageVerdicts> {
  const query = pull === undefined ? "" : `?repo=${enc(validateRepo(pull.repo))}&number=${pull.number}`;
  return TriageVerdicts.assert(await transport.fetch<unknown>("GET", `/api/integrations/triage-verdicts/${enc(requireTenantId(tenantId))}${query}`));
}

export type GithubPullDetail = {
  pr: {
    number: number;
    title: string;
    body: string | null;
    /** The description as a reader sees it, without hidden text such as HTML comments. */
    shownBody: string;
    state: string;
    merged: boolean;
    draft: boolean;
    author: string | null;
    sha: string;
    base: string;
    mergeable: boolean | null;
    /** GitHub's `mergeable_state`, such as `blocked` when the branch's rules refuse the merge; absent on Bitbucket. */
    mergeableState?: string;
    /** Read only when GitHub blocks the merge; null when no review is required or the read failed. */
    reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
    /** Whether Bitbucket's merge checks allow the merge; absent on GitHub. */
    canMerge?: boolean;
    /** Why Bitbucket's merge checks refuse the merge, one summary per check; absent on GitHub. */
    mergeVetoes?: string[];
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
  /** `codeReview` marks a code review sent from the portal. */
  reviews: Array<{ reviewer: string; state: string; submittedAt: string; commitId: string; codeReview?: true }>;
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

/** Whether the host would merge a pull request now: GitHub's `mergeableState` and `reviewDecision`, or Bitbucket's `canMerge` and `mergeVetoes`. */
export type MergeState = Pick<GithubPullDetail["pr"], "mergeable" | "mergeableState" | "reviewDecision" | "canMerge" | "mergeVetoes"> & { number: number };

export async function loadMergeStates(transport: Transport, tenantId: string, repo: string, numbers: number[]): Promise<MergeState[]> {
  const { prs } = await transport.fetch<{ prs: MergeState[] }>(
    "GET",
    `/api/integrations/merge-states/${enc(requireTenantId(tenantId))}?repo=${enc(validateRepo(repo))}&numbers=${numbers.join(",")}`,
  );
  return prs;
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

export async function assignRole(transport: Transport, tenantId: string, principalId: string, roleId: string): Promise<void> {
  await transport.fetch("POST", principalRolePath(tenantId, principalId, roleId));
}

export async function removeRole(transport: Transport, tenantId: string, principalId: string, roleId: string): Promise<void> {
  await transport.fetch("DELETE", principalRolePath(tenantId, principalId, roleId));
}

function principalRolePath(tenantId: string, principalId: string, roleId: string): string {
  return `/api/tenants/${enc(requireTenantId(tenantId))}/principals/${enc(requireId(principalId, "Principal id"))}/roles/${enc(requireId(roleId, "Role id"))}`;
}

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

async function tolerateSection<T>(work: Promise<T>, fallback: T): Promise<{ value: T; denied: boolean; failure?: ApiError }> {
  try {
    return { value: await work, denied: false };
  } catch (cause) {
    if (isSessionDead(cause)) throw cause;
    if (isAuthDenied(cause)) return { value: fallback, denied: true };
    if (cause instanceof ApiError) return { value: fallback, denied: false, failure: cause };
    throw cause;
  }
}

export async function listApprovals(transport: Transport, tenantId: string): Promise<HubApproval[]> {
  const tid = enc(requireTenantId(tenantId));
  return listAll<HubApproval>(transport, `/api/tenants/${tid}/approvals`);
}


async function readCodeReviewPlace(transport: Transport, tid: string): Promise<CodeReviewPlace> {
  return CodeReviewPlace.assert(await transport.fetch<unknown>("GET", `/api/integrations/code-review/${tid}/place`));
}

const EMPTY_CATALOG: Catalog = { providers: [], models: [], offerings: [] };

/** Only what the gate needs; approvals, runs and access rules are read by the pages that show them. */
export async function loadPortal(transport: Transport, access: MemberAccess, hasPack: CheckPackLookup): Promise<PortalSnapshot> {
  const { workspace, workspaces, invitations } = access;
  const tenantId = requireTenantId(workspace.tenantId);
  const tid = enc(tenantId);
  const tenantFallback: TenantBody = { id: tenantId, name: "", slug: WORKSPACE_SLUG };
  const [tenant, credentials, catalog, places] = await Promise.all([
    tolerateSection(transport.fetch<TenantBody>("GET", `/api/tenants/${tid}`), tenantFallback),
    tolerateSection(listAll<HubCredential>(transport, `/api/tenants/${tid}/credentials`), []),
    tolerateSection(listCatalog(transport, tenantId), EMPTY_CATALOG),
    tolerateSection(readCodeReviewPlace(transport, tid), undefined),
  ]);
  const decisionModel = decisionModelOf(catalog.value, credentials.value);
  return {
    workspace,
    tenantName: tenant.value.name,
    workspaces,
    invitations,
    repos: tenant.denied ? [] : await withPackPointers(reposFromConfig(tenant.value.config), hasPack),
    config: appConfig(tenant.value.config),
    configVersion: configFingerprint(tenant.value.config),
    credentials: credentials.value,
    ...(decisionModel && { decisionModel }),
    ...(places.value && { codeReviewPlace: places.value.provisioner, codeReviewPlaces: places.value.places }),
    ...(credentials.failure && { credentialsError: credentials.failure.message }),
    ...(places.failure && { codeReviewPlaceError: places.failure.message }),
    denied: {
      repos: tenant.denied,
      credentials: credentials.denied,
      models: catalog.denied,
    },
  };
}

export const BITBUCKET_DATACENTER_CREDENTIAL_NAME = "bitbucket-datacenter";

function hasBitbucketDatacenterCredential(credentials: HubCredential[]): boolean {
  return credentials.some((item) => item.name === BITBUCKET_DATACENTER_CREDENTIAL_NAME && isActiveCredential(item));
}

/** The pull request hosts the workspace connected: the GitHub App, a Bitbucket Data Center token. */
export function connectedSources(credentials: HubCredential[]): RepoSource[] {
  const sources: RepoSource[] = [];
  if (hasActiveGithubCredential(credentials)) sources.push("github");
  if (hasBitbucketDatacenterCredential(credentials)) sources.push("bitbucket-datacenter");
  return sources;
}

export function portalConnected(snapshot: PortalSnapshot): boolean {
  return connectedSources(snapshot.credentials).length > 0;
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

type CiState = "success" | "failure" | "pending" | "cancelled" | "none";

const CI_STATES: readonly unknown[] = ["success", "failure", "pending", "cancelled", "none"] satisfies CiState[];

function isCiState(value: unknown): value is CiState {
  return CI_STATES.includes(value);
}


/** Why the host holds a merge free of conflicts. */
export type HeldBlock = "behind" | "review-required" | "changes-requested" | "blocked";

/** `checking` until the host has said it would merge or why not, which is never taken for ready. */
export type MergeBlock = HeldBlock | "checking";

export type PrItem = {
  key: string;
  repo: string;
  number: number | null;
  title: string | null;
  author: string | null;
  /** Who the author is to the repository, known once the open pull requests have loaded; null when GitHub does not say. */
  authorKind: AuthorKind | null;
  /** Opened by Triage, known once the open pull requests have loaded; the host refuses its review. */
  byTriage: boolean;
  draft: boolean | null;
  mergeable: boolean | null;
  /** Why the host would refuse to merge it though free of conflicts, null once it said it would; read only for pull requests Triage passed. */
  mergeBlock: MergeBlock | null;
  state: QueueState;
  priority: string | null;
  owner: string | null;
  nextAction: string | null;
  verdict: VerdictWord | null;
  /** How likely it passes its policy, as the verdict question answered; null when it was not asked. */
  score: number | null;
  /** Why the verdict is what it is; empty on verdicts recorded before they carried reasons. */
  reasons: string[];
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
  updatedAt: string | null;
  ci: CiState | null;
  headSha: string | null;
  /** When the newest run triggered by author activity started; see `AUTHOR_ACTIVITY`. */
  activityAt: string | null;
  /** The verdict saw the author push, comment or reply in a review after the newest standing request for changes. */
  reviewAnswered: boolean;
  /** The verdict's reply is on GitHub: the run's mirror step wrote non-empty feedback, or this portal sent it (see `useQueueItems`). */
  posted: boolean;
  /** Why the run posted nothing on the host, when it said: `stale`, `waiting`, `no_request` or `no_grants`. */
  notPosted?: string;
  /** Why the policy's `for` or `when` left the verdict's head out of code review. */
  codeReviewSkipped?: string;
  running: boolean;
  /** Its policy reads CI, so triage holds this head until its CI finishes. */
  waitingForCi: boolean;
  /** The head Triage is holding for CI, when it is. */
  waitingHeadSha: string | null;
  /** Why the latest pr-triage run for this pull request ended without a verdict, when it did. */
  failure: RunFailure | null;
  actions: SuggestedAction[];
  automatic: ActionKind[];
  href: string;
  /** The host the pull request is on and its page there, known once the open pull requests have loaded. */
  source: RepoSource;
  url: string | null;
};

// The portal reads verdict JSON and does not import the workflow package, so this keeps only the fields it uses.
/** `held` waits for a maintainer's approval; `status` is how running it last ended, and `error` why it did not write. */
export type SuggestedAction = { list: VerdictWord; index: number; effectId: string; kind: ActionKind; reason: string; target: Record<string, unknown>; held: boolean; status?: DoStatus; error?: string };

const DO_STATUSES = ["done", "satisfied", "failed", "skipped"] as const;

type DoStatus = (typeof DO_STATUSES)[number];

function isDoStatus(value: unknown): value is DoStatus {
  return (DO_STATUSES as readonly unknown[]).includes(value);
}

function isActionKind(value: unknown): value is ActionKind {
  return (ACTION_KINDS as readonly unknown[]).includes(value);
}

function suggestedActions(actions: NonNullable<VerdictDetail["actions"]>): SuggestedAction[] {
  const out: SuggestedAction[] = [];
  for (const { list, index, effectId, kind, reason, target, skipped, held, status, error } of actions) {
    if (skipped || reason === undefined || !isActionKind(kind) || !target) continue;
    // A verdict from before Dos ran from verdict lists names none the hub can run.
    if (list === undefined || index === undefined || effectId === undefined) continue;
    out.push({ list, index, effectId, kind, reason, target, held: held === true, ...(isDoStatus(status) && { status }), ...(error !== undefined && { error }) });
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
  output: CheckOutput | null;
  /** An author rule: says who opened the pull request, shown as matched or not, never as a failure. */
  gate: boolean;
};

function isCheckResult(value: unknown): value is CheckResult["result"] {
  return value === "pass" || value === "fail" || value === "unconfirmed";
}

function checkResults(checks: NonNullable<VerdictDetail["checks"]>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const { check, kind, result, reason, evidence, output, gate } of checks) {
    // A verdict from before a rule was removed may still list it.
    if (RETIRED_CHECK_IDS.has(check) || (kind !== "machine" && kind !== "model") || !isCheckResult(result)) continue;
    for (const row of currentRows(check, evidence)) out.push({ ...row, kind, result, reason: reason ?? null, output: parseCheckOutput(output) ?? null, gate: gate === true });
  }
  return out;
}

function recordedChecks(checks: PullVerdict["checks"]): CheckResult[] {
  return checks.flatMap(({ check, result }) => (isCheckResult(result) && !RETIRED_CHECK_IDS.has(check) ? currentRows(check).map((row) => ({ ...row, kind: null, result, reason: null, output: null, gate: false })) : []));
}

function canonicalPrHref(repo: string, number: number): string {
  const [owner, name] = repo.split("/");
  return `/triage/pr/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}/${number}`;
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
  return run === null || run.status === "running" || run.status === "waiting-ci" ? null : run.status;
}

function waitingFields(run: PullRun | null | undefined): Pick<PrItem, "waitingForCi" | "waitingHeadSha"> {
  return run?.status === "waiting-ci" ? { waitingForCi: true, waitingHeadSha: run.headSha } : { waitingForCi: false, waitingHeadSha: null };
}

function isRunning(run: PullRun | null): boolean {
  return run?.status === "running";
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
    byTriage: false,
    draft: facts.draft ?? null,
    mergeable: facts.mergeable ?? null,
    mergeBlock: "checking",
    state: TRIAGE_TO_QUEUE[verdict.state] ?? "stale",
    priority: detail.priority || null,
    owner: detail.owner || null,
    nextAction: detail.nextAction || null,
    verdict: verdict.verdict,
    score: detail.score ?? null,
    reasons: detail.reasons ?? [],
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
    ...(detail.notPosted !== undefined && { notPosted: detail.notPosted }),
    ...(detail.codeReviewSkipped !== undefined && { codeReviewSkipped: detail.codeReviewSkipped }),
    running: isRunning(pull.run),
    ...waitingFields(pull.run),
    failure: failureOf(pull.run),
    actions: suggestedActions(detail.actions ?? []),
    automatic: ACTION_KINDS.filter((kind) => detail.automatic?.includes(kind)),
    href: canonicalPrHref(pull.repo, pull.number),
    source: "github",
    url: null,
  };
}

/** The queue keys by repository and number alone, so where both hosts have one, the pull request with the newer verdict stands. */
function newestPulls(pulls: PullTriage[]): Map<string, PullTriage> {
  const newest = new Map<string, PullTriage>();
  for (const pull of pulls) {
    const key = `${pull.repo}#${pull.number}`;
    const kept = newest.get(key)?.verdict;
    if (!kept || (pull.verdict && pull.verdict.at > kept.at)) newest.set(key, pull);
  }
  return newest;
}

/**
 * Queue projection from the hub's latest verdict of each pull request. Pending github_mirror approvals only
 * overlay needs-human; they never decide the verdict. With the open pull requests, unseen ones join as "new"
 * and verdicts of closed ones stop needing a human.
 */
export function projectQueue(pulls: PullTriage[], approvals: HubApproval[], openPulls: OpenPulls | undefined): PrItem[] {
  const items = new Map<string, PrItem>();
  const triage = newestPulls(pulls);
  for (const [key, pull] of triage) {
    if (pull.verdict) items.set(key, verdictItem(pull, pull.verdict));
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
  for (const { repo, source, prs, error } of openPulls.repos) {
    if (error) continue;
    const open = new Set(prs.map((pr) => `${repo}#${pr.number}`));
    for (const item of items.values()) {
      if (item.repo === repo && !open.has(item.key)) items.set(item.key, { ...item, needsHuman: false, closed: true });
    }
    for (const pr of prs) {
      const key = `${repo}#${pr.number}`;
      const known = items.get(key);
      if (known) {
        // A verdict recorded before the hub kept its facts takes the pull request's from GitHub; a draft is GitHub's now, not the verdict's.
        items.set(key, { ...known, title: known.title ?? pr.title, author: known.author ?? pr.author, draft: pr.draft, authorKind: pr.authorKind ?? null, byTriage: pr.byTriage === true, updatedAt: pr.updatedAt, headSha: pr.sha, source: repoSourceOf(source), url: pr.url ?? null });
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
        byTriage: pr.byTriage === true,
        draft: pr.draft,
        mergeable: null,
        mergeBlock: "checking",
        state: "new",
        priority: null,
        owner: null,
        nextAction: null,
        verdict: null,
        score: null,
        reasons: [],
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
        ...waitingFields(pull?.run),
        failure: failureOf(pull?.run ?? null),
        actions: [],
        automatic: [],
        href: canonicalPrHref(repo, pr.number),
        source: repoSourceOf(source),
        url: pr.url ?? null,
      });
    }
  }
}

type BitbucketDatacenterConnection = { baseUrl: string; hookUrl: string };

export type BitbucketDatacenterEnabled =
  | { webhook: "created"; hookUrl: string }
  | { webhook: "manual"; hookUrl: string; hookSecret: string; events: string[] };

export type BitbucketDatacenterManualWebhook = Extract<BitbucketDatacenterEnabled, { webhook: "manual" }>;

export type BitbucketDatacenterWebhook = BitbucketDatacenterManualWebhook | { webhook: "registered"; webhookId: number };

/** The hub's refusals as sentences; any other refusal keeps the hub's own text. */
const BITBUCKET_DATACENTER_REFUSALS: Record<string, string> = {
  bitbucket_datacenter_token_invalid: "Bitbucket Data Center did not accept this token. Check it has not expired and has project read and repository write.",
  not_bitbucket_datacenter: "This URL does not answer as a Bitbucket Data Center instance. Check the instance URL.",
  bitbucket_datacenter_connected_elsewhere: "This workspace is connected to another Bitbucket Data Center instance with repositories recorded. Disconnect it first.",
  bitbucket_datacenter_unreachable: "The hub could not reach this Bitbucket Data Center instance. Check the URL and that the hub can reach it.",
  bitbucket_datacenter_not_connected: "Connect Bitbucket Data Center in Settings first.",
  bitbucket_datacenter_host_refused: "The Triage server refuses this Bitbucket Data Center address. A private-network instance must be allowed by whoever runs the server.",
  bitbucket_datacenter_failed: "Bitbucket Data Center answered with an error. Try again in a moment.",
  repo_not_found: "Bitbucket Data Center does not show this repository to the token. Check the token can read its project.",
  repo_empty: "This repository has no default branch yet. Push a first commit, then turn on triage.",
  repo_name_taken: "A GitHub repository in this workspace has the same name, so this one cannot be triaged.",
};

function bitbucketDatacenterPath(tenantId: string, path: string): string {
  return `/api/integrations/bitbucket-datacenter/${enc(requireTenantId(tenantId))}${path}`;
}

/** The hub takes a mutation only as JSON from the portal, so bodiless ones send `{}`. */
async function bitbucketDatacenter<T>(transport: Transport, method: string, tenantId: string, path: string, body?: unknown): Promise<T> {
  try {
    return await transport.fetch<T>(method, bitbucketDatacenterPath(tenantId, path), body);
  } catch (cause) {
    const plain = cause instanceof ApiError ? BITBUCKET_DATACENTER_REFUSALS[cause.code] : undefined;
    throw plain === undefined ? cause : new Error(plain);
  }
}

function bitbucketDatacenterRepoPath(repo: string): string {
  const [project, slug] = validateRepo(repo).split("/");
  return `/repositories/${enc(project!)}/${enc(slug!)}`;
}

/** Null when the workspace has no Bitbucket Data Center connection. */
export async function loadBitbucketDatacenterConnection(transport: Transport, tenantId: string): Promise<BitbucketDatacenterConnection | null> {
  try {
    return await transport.fetch<BitbucketDatacenterConnection>("GET", bitbucketDatacenterPath(tenantId, "/connection"));
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null;
    throw cause;
  }
}

export async function connectBitbucketDatacenter(transport: Transport, tenantId: string, input: { baseUrl: string; token: string }): Promise<BitbucketDatacenterConnection> {
  return bitbucketDatacenter<BitbucketDatacenterConnection>(transport, "PUT", tenantId, "/connection", input);
}

/** Answers the enabled repositories whose webhook must be given the new secret on the instance by hand. */
export async function rotateBitbucketDatacenterHookSecret(transport: Transport, tenantId: string): Promise<{ webhooksByHand: string[] }> {
  return bitbucketDatacenter<{ webhooksByHand: string[] }>(transport, "PUT", tenantId, "/connection", { rotateHookSecret: true });
}

/** Answers the repositories whose webhook could not be removed and must be deleted on the instance. */
export async function disconnectBitbucketDatacenter(transport: Transport, tenantId: string): Promise<{ webhooksLeft: string[] }> {
  return bitbucketDatacenter<{ webhooksLeft: string[] }>(transport, "DELETE", tenantId, "/connection", {});
}

export async function listBitbucketDatacenterRepositories(transport: Transport, tenantId: string): Promise<RepoRecord[]> {
  const body = await bitbucketDatacenter<{ repositories: unknown[] }>(transport, "GET", tenantId, "/repositories");
  return repoRecords(body.repositories);
}

export async function enableBitbucketDatacenterRepository(transport: Transport, tenantId: string, repo: string): Promise<BitbucketDatacenterEnabled> {
  return bitbucketDatacenter<BitbucketDatacenterEnabled>(transport, "POST", tenantId, `${bitbucketDatacenterRepoPath(repo)}/enable`, {});
}

export async function loadBitbucketDatacenterWebhook(transport: Transport, tenantId: string, repo: string): Promise<BitbucketDatacenterWebhook> {
  return bitbucketDatacenter<BitbucketDatacenterWebhook>(transport, "GET", tenantId, `${bitbucketDatacenterRepoPath(repo)}/webhook`);
}

/** Sends the pull request's code review of `headSha`; `sent` is false when it was already there. */
export async function sendBitbucketDatacenterCodeReview(transport: Transport, tenantId: string, repo: string, number: number, headSha: string): Promise<{ commentId: number; sent: boolean }> {
  return bitbucketDatacenter<{ commentId: number; sent: boolean }>(transport, "POST", tenantId, "/code-review", { repo: validateRepo(repo), number, headSha });
}

/** `webhookLeft` is true when the webhook triage created could not be removed. */
export async function disableBitbucketDatacenterRepository(transport: Transport, tenantId: string, repo: string): Promise<{ webhookLeft: boolean }> {
  return bitbucketDatacenter<{ webhookLeft: boolean }>(transport, "POST", tenantId, `${bitbucketDatacenterRepoPath(repo)}/disable`, {});
}
