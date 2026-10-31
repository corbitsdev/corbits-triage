import { type } from "arktype";
import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { UpdateTenant } from "@intx/types";
import { AUTOMATION_MODES, REPO_SOURCES, repoPolicy, repoSourceOf, type AutomationMode, type RepoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { asRecord, isRecord } from "@corbits/common";
import { readCappedBody } from "../read-json.js";
import type { Tx } from "./admin-github-grant.js";
import { grantWanted, revokeRepoKinds } from "./automation.js";
import { failure, memberPrincipal, sourceCredentialGrant, type GrantDeps } from "./portal-credential.js";

const CONFIG_KEY = "corbitsTriage";

export type RepoRecord = {
  name: string;
  /** Absent means github. */
  source?: RepoSource;
  connected: boolean;
  defaultBranch?: string;
  /** The Bitbucket webhook triage created, so disabling removes only its own. */
  webhookId?: number;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  enabled?: boolean;
  checks?: RepoPolicy["checks"];
};

export type InstallationFields = {
  installationId: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
};

export type CorbitsTriageNs = {
  repos?: RepoRecord[];
  bitbucketDatacenter?: unknown;
  allowlist?: unknown;
  labelMap?: unknown;
  rev?: number;
  [key: string]: unknown;
};

function isRepoRecord(row: unknown): row is RepoRecord {
  if (!row || typeof row !== "object") return false;
  const rec = row as Record<string, unknown>;
  return typeof rec["name"] === "string" && rec["name"].length > 0 && typeof rec["connected"] === "boolean";
}

export function repoRecords(ns: CorbitsTriageNs): RepoRecord[] {
  return Array.isArray(ns.repos) ? ns.repos.filter(isRepoRecord) : [];
}

export function sourceOf(record: Pick<RepoRecord, "source">): RepoSource {
  return repoSourceOf(record.source);
}

/**
 * The connected repository of this name. A named host matches only that host. With none named, two connected rows
 * resolve to GitHub, and a single row is used as it is, so a Bitbucket-only repository still reads.
 */
export function connectedNamed(records: readonly RepoRecord[], repo: string, source: RepoSource | undefined): RepoRecord | undefined {
  const named = records.filter((record) => record.name === repo && record.connected);
  if (source !== undefined) return named.find((record) => sourceOf(record) === source);
  return named.find((record) => sourceOf(record) === "github") ?? (named.length === 1 ? named[0] : undefined);
}

/** What the triage state and its queue key a repository by: GitHub ones keep their name, so stored state keeps matching; another host's carries its source. */
export function triageStateKey(record: Pick<RepoRecord, "name" | "source">): string {
  const source = sourceOf(record);
  return source === "github" ? record.name : `${source}:${record.name}`;
}

export function triageNs(config: unknown): CorbitsTriageNs {
  const ns = asRecord(config)?.[CONFIG_KEY];
  return asRecord(ns) ?? {};
}

/** Absent means `policy`; the namespace is config a manager may write, so anything but `ask` is too. */
export function automationMode(ns: CorbitsTriageNs): AutomationMode {
  return ns["automation"] === "ask" ? "ask" : "policy";
}

function nsRev(ns: CorbitsTriageNs): number {
  return typeof ns.rev === "number" ? ns.rev : 0;
}

/**
 * Repositories the patch switches off or removes, each with its host. Removal is the triage state key; one still
 * enabled on that host is left, and another host's record of the same name is not.
 */
function switchedOff(before: CorbitsTriageNs, after: CorbitsTriageNs): { name: string; source: RepoSource }[] {
  const kept = new Set(repoRecords(after).map(triageStateKey));
  const on = new Set(repoRecords(after).filter((row) => row.enabled === true).map((row) => `${sourceOf(row)}:${row.name.toLowerCase()}`));
  return repoRecords(before)
    .filter((row) => (row.enabled === true || !kept.has(triageStateKey(row))) && !on.has(`${sourceOf(row)}:${row.name.toLowerCase()}`))
    .map((row) => ({ name: row.name, source: sourceOf(row) }));
}

/**
 * Rewrites `tenant.config.corbitsTriage` under a row lock; undefined when the
 * tenant is missing. Bumps `rev` so a concurrent portal PATCH can 409 instead
 * of clobbering install writes. A patch returning undefined writes nothing.
 * Every writer of the namespace comes through here, so a repository switched
 * off or removed loses what triage may do on it on its own in the same write.
 * The namespace's first write is a new workspace's, which starts under `policy`.
 */
export async function patchCorbitsTriage(
  db: DB["db"],
  tenantId: string,
  patch: (ns: CorbitsTriageNs, tx: Tx) => CorbitsTriageNs | undefined | Promise<CorbitsTriageNs | undefined>,
): Promise<CorbitsTriageNs | undefined> {
  return db.transaction(async function patchLocked(tx) {
    const [row] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("update");
    if (!row) return undefined;
    const existing = asRecord(row.config) ?? {};
    const current = triageNs(existing);
    const patched = await patch(current, tx);
    if (patched === undefined) return current;
    for (const repo of switchedOff(current, patched)) await revokeRepoKinds(tx, tenantId, repo.name, repo.source);
    const fresh = !(CONFIG_KEY in existing) && patched["automation"] === undefined;
    const nextNs = { ...patched, ...(fresh && { automation: "policy" }), rev: nsRev(current) + 1 };
    await tx.update(schema.tenant)
      .set({ config: { ...existing, [CONFIG_KEY]: nextNs }, updatedAt: new Date() })
      .where(eq(schema.tenant.id, tenantId));
    return nextNs;
  });
}

type LegacyRepoRecord = RepoRecord & { classificationAuthorized?: unknown };

function hasLegacyFlag(row: unknown): boolean {
  return asRecord(row)?.["classificationAuthorized"] !== undefined;
}

function renameLegacyFlag(row: LegacyRepoRecord): RepoRecord {
  if (!hasLegacyFlag(row)) return row;
  const { classificationAuthorized, ...rest } = row;
  if (rest.enabled !== undefined || typeof classificationAuthorized !== "boolean") return rest;
  return { ...rest, enabled: classificationAuthorized };
}

function renameLegacyFlags(ns: CorbitsTriageNs): CorbitsTriageNs {
  return Array.isArray(ns.repos) ? { ...ns, repos: ns.repos.map(renameLegacyFlag) } : ns;
}

/**
 * Workspaces set up before `automation` existed had every action but posting wait for a person unless allowed by hand,
 * so they keep that under `ask`, grants included, until an owner switches. A namespace written since carries its mode,
 * so after the first boot this finds none; a tenant with no namespace never connected a host and starts under `policy`.
 */
export async function keepExistingWorkspacesAsking(db: DB["db"], log: (entry: Record<string, unknown>) => void): Promise<void> {
  const tenants = await db.select({ id: schema.tenant.id, config: schema.tenant.config }).from(schema.tenant);
  let asking = 0;
  for (const tenant of tenants) {
    const ns = asRecord(tenant.config)?.[CONFIG_KEY];
    if (!isRecord(ns) || ns["automation"] !== undefined) continue;
    await patchCorbitsTriage(db, tenant.id, function keepAsking(current) {
      if (current["automation"] !== undefined) return undefined;
      asking += 1;
      return { ...current, automation: "ask" };
    });
  }
  if (asking > 0) log({ level: "info", msg: "existing_workspaces_kept_asking", workspaces: asking });
}

/** One-time rewrite of repo rows stored before `classificationAuthorized` was renamed to `enabled`. */
export async function migrateRepoEnabledFlag(db: DB["db"]): Promise<void> {
  const tenants = await db.select({ id: schema.tenant.id, config: schema.tenant.config }).from(schema.tenant);
  for (const tenant of tenants) {
    const repos = triageNs(tenant.config).repos;
    if (Array.isArray(repos) && repos.some(hasLegacyFlag)) await patchCorbitsTriage(db, tenant.id, renameLegacyFlags);
  }
}

function cloneWithBody(req: Request, body: string): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body });
}

/** Checked as stock does, before the body or tenant is read; the manager's principal id, or the refusal. */
export async function tenantManager(
  d: GrantDeps & { getSession: (headers: Headers) => Promise<{ user: { id: string } } | null> },
  tenantId: string,
  headers: Headers,
): Promise<string | Response> {
  const session = await d.getSession(headers);
  if (!session) return failure(401, "unauthorized", "Authentication required");
  const principalId = await memberPrincipal(d.db, tenantId, session.user.id);
  if (principalId === undefined) return failure(403, "forbidden", "Not a member of this tenant");
  if (await d.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage")) return principalId;
  return failure(403, "forbidden", "You do not have permission to manage this tenant");
}

/** What a member may change in the namespace through the tenant route; everything else keeps its stored value. */
const TriagePatch = type({
  "+": "delete",
  "rev?": "number",
  "automation?": type.enumerated(...AUTOMATION_MODES),
  "repos?": type({
    "+": "delete",
    name: "string > 0",
    "source?": type.enumerated(...REPO_SOURCES),
    "enabled?": "boolean",
  }).array(),
});

type TriagePatch = typeof TriagePatch.infer;

/** `after` is undefined for a record the patch removes. */
type RepoChange = { before: RepoRecord; after: RepoRecord | undefined };

/** Records the patch leaves out are removed; a record it names that is not stored is refused. */
function patchedRepos(stored: RepoRecord[], patch: NonNullable<TriagePatch["repos"]>): RepoChange[] | Response {
  const byKey = new Map(patch.map((row) => [triageStateKey(row), row]));
  const storedKeys = new Set(stored.map(triageStateKey));
  const unknown = patch.find((row) => !storedKeys.has(triageStateKey(row)));
  if (unknown) return failure(400, "repo_not_found", `The workspace has no repository ${unknown.name}.`);
  return stored.map(function patched(before) {
    const row = byKey.get(triageStateKey(before));
    if (!row) return { before, after: undefined };
    const { name: _name, source: _source, ...fields } = row;
    return { before, after: { ...before, ...fields } };
  });
}

type PatchDeps = GrantDeps & { grantEnabled: (tx: Tx, repo: string) => Promise<void>; now: () => Date };

/** Each change needs the grant its own route needs: switching off or removing an enabled Bitbucket repository also removes the webhook, so it is refused here, as is switching one on. */
async function changeRefusal(d: PatchDeps, tenantId: string, principalId: string, { before, after }: RepoChange): Promise<Response | undefined> {
  const wasOn = before.enabled === true;
  const isOn = after?.enabled === true;
  if (wasOn !== isOn && sourceOf(before) !== "github") {
    return failure(409, "use_bitbucket_route", "Turn Bitbucket Data Center repositories on or off with their own switch.");
  }
  if (isOn && !wasOn) return sourceCredentialGrant(d, principalId, tenantId, before, "use");
  return undefined;
}

function conflict(): Response {
  return Response.json({ error: "config_conflict" }, { status: 409 });
}

/**
 * CAS for portal PATCH /api/tenants/:id that carries `config.corbitsTriage`.
 * Matching rev ⇒ the hub writes the stored namespace with the changes `TriagePatch` allows and the caller holds the
 * grants for, rev current+1, under the row lock, granting each GitHub repository switched on in the same transaction;
 * the request goes on to stock without `corbitsTriage`, so stock's own write cannot overwrite a namespace written since.
 * Stale rev ⇒ 409 `{ error: "config_conflict" }`. Over 1 MB ⇒ 413.
 */
export async function prepareCorbitsTriagePatch(
  d: PatchDeps,
  tenantId: string,
  principalId: string,
  req: Request,
): Promise<Request | Response> {
  const raw = await readCappedBody(req);
  if (raw === null) return failure(413, "payload_too_large", "Request body too large");
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return cloneWithBody(req, raw);
  }
  const body = asRecord(parsed);
  const config = asRecord(body?.["config"]);
  if (!body || !config || !(CONFIG_KEY in config)) return cloneWithBody(req, raw);
  const { [CONFIG_KEY]: incoming, ...otherConfig } = config;
  if (!isRecord(incoming)) return failure(400, "invalid_request", `${CONFIG_KEY} must be an object`);
  const patch = TriagePatch(incoming);
  if (patch instanceof type.errors) return failure(400, "invalid_request", `${CONFIG_KEY}: ${patch.summary}`);
  // Checked before the namespace is written, so a body stock would refuse saves nothing.
  const forwarded = { ...body, config: otherConfig };
  const rest = UpdateTenant(forwarded);
  if (rest instanceof type.errors) return failure(400, "invalid_request", rest.summary);

  const [unlocked] = await d.db.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  const stored = triageNs(unlocked?.config);
  const storedRev = nsRev(stored);
  if ((patch.rev ?? 0) !== storedRev) return conflict();
  const changes = patch.repos === undefined ? [] : patchedRepos(repoRecords(stored), patch.repos);
  if (changes instanceof Response) return changes;
  // Checked before the row lock, so the lock is held briefly and no pooled connection is held while these take another.
  for (const change of changes) {
    const refused = await changeRefusal(d, tenantId, principalId, change);
    if (refused) return refused;
  }
  let conflicted = false;
  await patchCorbitsTriage(d.db, tenantId, async function applyPatch(current, tx) {
    // Every write of the namespace bumps rev, so an unchanged rev means the namespace authorized above is the one stored.
    if (nsRev(current) !== storedRev) {
      conflicted = true;
      return undefined;
    }
    for (const { before, after } of changes) {
      if (after?.enabled === true && before.enabled !== true) await d.grantEnabled(tx, after.name);
    }
    const repos = patch.repos === undefined ? {} : { repos: changes.flatMap((change) => change.after ?? []) };
    const next = { ...current, ...repos, ...(patch.automation && { automation: patch.automation }) };
    // Switching to `ask` takes back every kind a policy granted but posting; switching to `policy` writes no grant
    // here, the next policy read of each enabled repository does.
    if (automationMode(current) === "policy" && automationMode(next) === "ask") {
      for (const record of repoRecords(next).filter((each) => each.enabled === true)) await grantWanted(tx, tenantId, record.name, sourceOf(record), [], d.now());
    }
    return next;
  });
  if (conflicted) return conflict();
  return cloneWithBody(req, JSON.stringify(forwarded));
}

/** Repositories new to the config are recorded disabled: nothing runs until a user enables one. Another host's record of the same name is left alone. */
export function upsertConnectedRepos(
  ns: CorbitsTriageNs,
  names: readonly string[],
  fields: InstallationFields,
): CorbitsTriageNs {
  const repos = [...repoRecords(ns)];
  const index = new Map(repos.flatMap((row, i) => (sourceOf(row) === "github" ? [[row.name, i] as const] : [])));
  for (const name of names) {
    const at = index.get(name);
    if (at === undefined) {
      index.set(name, repos.length);
      repos.push({ name, connected: true, ...fields, ...repoPolicy(undefined) });
      continue;
    }
    const prev = repos[at]!;
    repos[at] = { ...prev, connected: true, ...fields };
  }
  return { ...ns, repos };
}

export function dropGithubReposByName(ns: CorbitsTriageNs, names: readonly string[]): CorbitsTriageNs {
  const drop = new Set(names);
  return { ...ns, repos: repoRecords(ns).filter((row) => sourceOf(row) !== "github" || !drop.has(row.name)) };
}

export function dropReposByInstallation(ns: CorbitsTriageNs, installationId: number): CorbitsTriageNs {
  return { ...ns, repos: repoRecords(ns).filter((row) => row.installationId !== installationId) };
}

export function setConnectedForInstallation(
  ns: CorbitsTriageNs,
  installationId: number,
  connected: boolean,
): CorbitsTriageNs {
  return {
    ...ns,
    repos: repoRecords(ns).map((row) => (row.installationId === installationId ? { ...row, connected } : row)),
  };
}
