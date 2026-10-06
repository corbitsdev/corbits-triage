import { eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";

export const CONFIG_KEY = "corbitsTriage";

export type RepoRecord = {
  name: string;
  connected: boolean;
  installationId?: number;
  account?: string;
  installationUrl?: string;
  selection?: "all" | "selected";
  cleanupMode?: RepoPolicy["cleanupMode"];
  classificationAuthorized?: boolean;
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
  confidenceFloor?: unknown;
  allowlist?: unknown;
  labelMap?: unknown;
  backlogSync?: unknown;
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

function nsRev(ns: CorbitsTriageNs): number {
  return typeof ns.rev === "number" ? ns.rev : 0;
}

/**
 * Rewrites `tenant.config.corbitsTriage` under a row lock; undefined when the
 * tenant is missing. Bumps `rev` so a concurrent portal PATCH can 409 instead
 * of clobbering install writes.
 */
export async function patchCorbitsTriage(
  db: DB["db"],
  tenantId: string,
  patch: (ns: CorbitsTriageNs) => CorbitsTriageNs,
): Promise<CorbitsTriageNs | undefined> {
  return db.transaction(async function patchLocked(tx) {
    const [row] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)).for("update");
    if (!row) return undefined;
    const existing = asRecord(row.config) ?? {};
    const current = triageNs(existing);
    const nextNs = { ...patch(current), rev: nsRev(current) + 1 };
    await tx.update(schema.tenant)
      .set({ config: { ...existing, [CONFIG_KEY]: nextNs }, updatedAt: new Date() })
      .where(eq(schema.tenant.id, tenantId));
    return nextNs;
  });
}

function cloneWithBody(req: Request, body: string): Request {
  const headers = new Headers(req.headers);
  headers.delete("content-length");
  return new Request(req.url, { method: req.method, headers, body });
}

/**
 * CAS for portal PATCH /api/tenants/:id that carries `config.corbitsTriage`.
 * Matching rev ⇒ rewrite body to current+1 and let stock.fetch do the write.
 * Stale rev ⇒ 409 `{ error: "config_conflict" }`. Authz is still stock's.
 */
export async function prepareCorbitsTriagePatch(
  db: DB["db"],
  tenantId: string,
  req: Request,
): Promise<Request | Response> {
  const raw = await req.text();
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

export function upsertConnectedRepos(
  ns: CorbitsTriageNs,
  names: readonly string[],
  fields: InstallationFields,
): { ns: CorbitsTriageNs; added: string[] } {
  const repos = [...repoRecords(ns)];
  const index = new Map(repos.map((row, i) => [row.name, i]));
  const added: string[] = [];
  for (const name of names) {
    const at = index.get(name);
    if (at === undefined) {
      added.push(name);
      index.set(name, repos.length);
      repos.push({ name, connected: true, ...fields, ...repoPolicy(undefined) });
      continue;
    }
    const prev = repos[at]!;
    repos[at] = { ...prev, connected: true, ...fields };
  }
  return { ns: { ...ns, repos }, added };
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

function backlogSyncMap(ns: CorbitsTriageNs): Record<string, Record<string, unknown>> {
  const raw = asRecord(ns.backlogSync) ?? {};
  const next: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(raw)) {
    const row = asRecord(value);
    if (row) next[name] = row;
  }
  return next;
}

/** Pending or failed: not yet succeeded. */
export function owesBacklog(ns: CorbitsTriageNs, name: string): boolean {
  const status = backlogSyncMap(ns)[name]?.["status"];
  return status === "pending" || status === "failed";
}

/** Never downgrades a succeeded sync. */
export function markBacklogPending(ns: CorbitsTriageNs, names: readonly string[]): CorbitsTriageNs {
  const sync = backlogSyncMap(ns);
  for (const name of names) {
    const prev = sync[name] ?? {};
    if (prev["status"] === "succeeded") continue;
    sync[name] = { ...prev, status: "pending" };
  }
  return { ...ns, backlogSync: sync };
}

export function namesNeedingBacklog(ns: CorbitsTriageNs, names: readonly string[]): string[] {
  return names.filter((name) => owesBacklog(ns, name));
}
