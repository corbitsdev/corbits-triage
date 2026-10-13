import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { readCappedBody } from "../read-json.js";
import { failure, memberPrincipal, type PortalCredentialDeps } from "./portal-credential.js";

export const CONFIG_KEY = "corbitsTriage";

export type RepoRecord = {
  name: string;
  connected: boolean;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  cleanupMode?: RepoPolicy["cleanupMode"];
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
  allowlist?: unknown;
  labelMap?: unknown;
  rev?: number;
  [key: string]: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isRepoRecord(row: unknown): row is RepoRecord {
  if (!row || typeof row !== "object") return false;
  const rec = row as Record<string, unknown>;
  return typeof rec["name"] === "string" && rec["name"].length > 0 && typeof rec["connected"] === "boolean";
}

export function repoRecords(ns: CorbitsTriageNs): RepoRecord[] {
  return Array.isArray(ns.repos) ? ns.repos.filter(isRepoRecord) : [];
}

export function triageNs(config: unknown): CorbitsTriageNs {
  const ns = asRecord(config)?.[CONFIG_KEY];
  return asRecord(ns) ?? {};
}

export function nsRev(ns: CorbitsTriageNs): number {
  return typeof ns.rev === "number" ? ns.rev : 0;
}

/**
 * Rewrites `tenant.config.corbitsTriage` under a row lock; undefined when the
 * tenant is missing. Bumps `rev` so a concurrent portal save can 409 instead
 * of clobbering install writes. A patch returning undefined writes nothing.
 */
export async function patchCorbitsTriage(
  db: DB["db"],
  tenantId: string,
  patch: (ns: CorbitsTriageNs) => CorbitsTriageNs | undefined,
): Promise<CorbitsTriageNs | undefined> {
  return db.transaction(async function patchLocked(tx) {
    const [row] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("update");
    if (!row) return undefined;
    const existing = asRecord(row.config) ?? {};
    const current = triageNs(existing);
    const patched = patch(current);
    if (patched === undefined) return current;
    const nextNs = { ...patched, rev: nsRev(current) + 1 };
    await tx.update(schema.tenant)
      .set({ config: { ...existing, [CONFIG_KEY]: nextNs }, updatedAt: new Date() })
      .where(eq(schema.tenant.id, tenantId));
    return nextNs;
  });
}

/** The pr-triage deployment the hub replaced (`from`) and the copy it deployed for it (`to`). */
export type RotationRecord = { from: string; to: string; at: string };

export function rotationRecord(ns: CorbitsTriageNs): RotationRecord | undefined {
  const value = asRecord(ns["rotation"]);
  const { from, to, at } = value ?? {};
  return typeof from === "string" && typeof to === "string" && typeof at === "string" ? { from, to, at } : undefined;
}

/** Records the rotation unless one is recorded already; true when this one was. */
export async function claimRotation(db: DB["db"], tenantId: string, record: RotationRecord): Promise<boolean> {
  let claimed = false;
  await patchCorbitsTriage(db, tenantId, function claim(ns) {
    if (rotationRecord(ns) !== undefined) return undefined;
    claimed = true;
    return { ...ns, rotation: record };
  });
  return claimed;
}

/** Clears the rotation when it is still this one. */
export async function clearRotation(db: DB["db"], tenantId: string, record: RotationRecord): Promise<void> {
  await patchCorbitsTriage(db, tenantId, function clear(ns) {
    const current = rotationRecord(ns);
    if (current?.from !== record.from || current.to !== record.to) return undefined;
    const { rotation: _rotation, ...rest } = ns;
    return rest;
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

/** One-time rewrite of repo rows stored before `classificationAuthorized` was renamed to `enabled`. */
export async function migrateRepoEnabledFlag(db: DB["db"]): Promise<void> {
  const tenants = await db.select({ id: schema.tenant.id, config: schema.tenant.config }).from(schema.tenant);
  for (const tenant of tenants) {
    const repos = triageNs(tenant.config).repos;
    if (Array.isArray(repos) && repos.some(hasLegacyFlag)) await patchCorbitsTriage(db, tenant.id, renameLegacyFlags);
  }
}

/** The triage namespace as stored, or undefined when the tenant is missing. */
async function loadCorbitsTriage(db: DB["db"], tenantId: string): Promise<CorbitsTriageNs | undefined> {
  const [row] = await db.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  return row && triageNs(row.config);
}

export type CorbitsTriageSave = { saved: boolean; ns: CorbitsTriageNs };

/**
 * Replaces `tenant.config.corbitsTriage` with `ns` at `rev + 1` in one
 * conditional update that matches only while the stored rev is still `rev`.
 * A miss reports the stored namespace unsaved; undefined when the tenant is missing.
 */
export async function saveCorbitsTriage(
  db: DB["db"],
  tenantId: string,
  rev: number,
  ns: CorbitsTriageNs,
): Promise<CorbitsTriageSave | undefined> {
  const next = { ...ns, rev: rev + 1 };
  const [row] = await db.update(schema.tenant)
    .set({
      config: sql`jsonb_set(coalesce(${schema.tenant.config}, '{}'::jsonb), ${`{${CONFIG_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.tenant.id, tenantId),
      // A missing or non-numeric rev counts as 0, as nsRev reads it.
      sql`(case when jsonb_typeof(${schema.tenant.config} #> ${`{${CONFIG_KEY},rev}`}::text[]) = 'number' then ${schema.tenant.config} #> ${`{${CONFIG_KEY},rev}`}::text[] else '0'::jsonb end) = ${JSON.stringify(rev)}::jsonb`,
    ))
    .returning({ id: schema.tenant.id });
  if (row) return { saved: true, ns: next };
  const current = await loadCorbitsTriage(db, tenantId);
  return current && { saved: false, ns: current };
}

function cloneWithBody(req: Request, body: string): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body });
}

/** The response refusing PATCH /api/tenants/:id, checked as stock does before the body or tenant is read; undefined when the caller may manage the tenant. */
export async function tenantManagerRefusal(
  d: Pick<PortalCredentialDeps, "db" | "getSession" | "authorize">,
  tenantId: string,
  headers: Headers,
): Promise<Response | undefined> {
  const session = await d.getSession(headers);
  if (!session) return failure(401, "unauthorized", "Authentication required");
  const principalId = await memberPrincipal(d.db, tenantId, session.user.id);
  if (principalId === undefined) return failure(403, "forbidden", "Not a member of this tenant");
  if (await d.authorize(principalId, tenantId, `tenant:${tenantId}`, "manage")) return undefined;
  return failure(403, "forbidden", "You do not have permission to manage this tenant");
}

/**
 * Stock PATCH /api/tenants/:id writes config unconditionally, so a body that
 * carries `config.corbitsTriage` is refused (400) in favour of the triage-config
 * route; any other body is passed on. Over 1 MB ⇒ 413.
 */
export async function guardTenantPatch(req: Request): Promise<Request | Response> {
  const raw = await readCappedBody(req);
  if (raw === null) return failure(413, "payload_too_large", "Request body too large");
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    return cloneWithBody(req, raw);
  }
  if (asRecord(asRecord(parsed)?.["config"])?.[CONFIG_KEY] !== undefined) {
    return failure(400, "invalid_request", `Save ${CONFIG_KEY} through PUT /api/integrations/triage-config/:tenantId.`);
  }
  return cloneWithBody(req, raw);
}

/** Repositories new to the config are recorded disabled: nothing runs until a user enables one. */
export function upsertConnectedRepos(
  ns: CorbitsTriageNs,
  names: readonly string[],
  fields: InstallationFields,
): CorbitsTriageNs {
  const repos = [...repoRecords(ns)];
  const index = new Map(repos.map((row, i) => [row.name, i]));
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

export function dropReposByName(ns: CorbitsTriageNs, names: readonly string[]): CorbitsTriageNs {
  const drop = new Set(names);
  return { ...ns, repos: repoRecords(ns).filter((row) => !drop.has(row.name)) };
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
