import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { asRecord } from "@corbits/common";
import { readCappedBody } from "../read-json.js";
import type { Tx } from "./admin-github-grant.js";
import { failure, memberPrincipal, type PortalCredentialDeps } from "./portal-credential.js";

const CONFIG_KEY = "corbitsTriage";

export type RepoRecord = {
  name: string;
  connected: boolean;
  /** Absent means GitHub. */
  source?: "github" | "bitbucket";
  defaultBranch?: string;
  /** The Bitbucket webhook triage created, so disabling removes only its own. */
  webhookId?: number;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  enabled?: boolean;
  checks?: RepoPolicy["checks"];
  checkPack?: RepoPolicy["checkPack"];
};

export type InstallationFields = {
  installationId: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
};

export type CorbitsTriageNs = {
  repos?: RepoRecord[];
  bitbucket?: unknown;
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

/** Records GitHub serves; Bitbucket repositories are read through their own instance. */
export function githubRepoRecords(ns: CorbitsTriageNs): RepoRecord[] {
  return repoRecords(ns).filter((row) => row.source !== "bitbucket");
}

export function triageNs(config: unknown): CorbitsTriageNs {
  const ns = asRecord(config)?.[CONFIG_KEY];
  return asRecord(ns) ?? {};
}

function nsRev(ns: CorbitsTriageNs): number {
  return typeof ns.rev === "number" ? ns.rev : 0;
}

/**
 * Rewrites `tenant.config.corbitsTriage` under a row lock; undefined when the
 * tenant is missing. Bumps `rev` so a concurrent portal PATCH can 409 instead
 * of clobbering install writes. A patch returning undefined writes nothing.
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
    const nextNs = { ...patched, rev: nsRev(current) + 1 };
    await tx.update(schema.tenant)
      .set({ config: { ...existing, [CONFIG_KEY]: nextNs }, updatedAt: new Date() })
      .where(eq(schema.tenant.id, tenantId));
    return nextNs;
  });
}

export type RotationRecord = { from: string; to: string; at: string };

export function rotationRecord(ns: CorbitsTriageNs): RotationRecord | undefined {
  const value = asRecord(ns["rotation"]);
  const { from, to, at } = value ?? {};
  return typeof from === "string" && typeof to === "string" && typeof at === "string" ? { from, to, at } : undefined;
}

export async function claimRotation(db: DB["db"], tenantId: string, record: RotationRecord): Promise<boolean> {
  let claimed = false;
  await patchCorbitsTriage(db, tenantId, function claim(ns) {
    if (rotationRecord(ns) !== undefined) return undefined;
    claimed = true;
    return { ...ns, rotation: record };
  });
  return claimed;
}

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

function cloneWithBody(req: Request, body: string): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body });
}

/** Checked as stock does, before the body or tenant is read. */
export async function tenantManagerRefusal(
  d: Pick<PortalCredentialDeps, "db" | "authorize"> & { getSession: (headers: Headers) => Promise<{ user: { id: string } } | null> },
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
 * CAS for portal PATCH /api/tenants/:id that carries `config.corbitsTriage`.
 * Matching rev ⇒ rewrite body to current+1 and let stock.fetch do the write.
 * Stale rev ⇒ 409 `{ error: "config_conflict" }`. Over 1 MB ⇒ 413.
 */
export async function prepareCorbitsTriagePatch(
  db: DB["db"],
  tenantId: string,
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
  const incomingNs = asRecord(config?.[CONFIG_KEY]);
  if (!body || !config || !incomingNs) return cloneWithBody(req, raw);

  const incomingRev = incomingNs["rev"] ?? 0;
  const outcome = await db.transaction(async function compareRev(tx) {
    const [row] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("update");
    const currentRev = nsRev(triageNs(row?.config));
    if (incomingRev !== currentRev) return { conflict: true as const };
    return { conflict: false as const, nextRev: currentRev + 1 };
  });
  if (outcome.conflict) {
    return Response.json({ error: "config_conflict" }, { status: 409 });
  }
  return cloneWithBody(req, JSON.stringify({
    ...body,
    config: { ...config, [CONFIG_KEY]: { ...incomingNs, rev: outcome.nextRev } },
  }));
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
