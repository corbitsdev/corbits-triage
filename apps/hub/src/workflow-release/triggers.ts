// What starts a roll besides the hub's own start: a write through a stock route, and a host found with no listener.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { asRecord } from "@corbits/common";
import { REPO_SOURCES, type RepoSource } from "@corbits/triage-contracts";

/** A write that can change a workspace's release: its catalog decides which workflows publish and the offerings they run on. */
const RELEASE_WRITE = /^\/api\/tenants\/([^/]+)\/(credentials|catalog\/(?:providers|models|offerings))(?:\/([^/]+))?$/;
const WRITE_METHODS = new Set(["POST", "PATCH", "DELETE"]);

/** A workspace to roll after a write succeeds, and the hosts whose listeners start again with what it changed. */
export type ReleaseWrite = { tenantId: string; redeploy: readonly RepoSource[] };

/** A host's own credentials are named for it; any other, such as a model key, reaches every host's workflows. */
export function credentialHosts(name: string): readonly RepoSource[] {
  const host = REPO_SOURCES.find((source) => name === source || name.startsWith(`${source}-`));
  return host ? [host] : REPO_SOURCES;
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

async function credentialName(db: DB["db"], req: Request, tenantId: string, credentialId: string | undefined): Promise<string | undefined> {
  if (credentialId === undefined) {
    let body: unknown;
    try {
      body = await req.clone().json();
    } catch {
      // Stock refuses the write; nothing rolls.
      return undefined;
    }
    const name = asRecord(body)?.["name"];
    return typeof name === "string" ? name : undefined;
  }
  const row = await db.query.credential.findFirst({ where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.id, credentialId)), columns: { name: true } });
  return row?.name;
}

/** Read before the write is forwarded, since a deleted credential can no longer be named. */
export async function releaseWriteOf(db: DB["db"], req: Request, path: string): Promise<ReleaseWrite | undefined> {
  if (!WRITE_METHODS.has(req.method)) return undefined;
  const written = RELEASE_WRITE.exec(path);
  const tenantId = written ? decoded(written[1]!) : undefined;
  if (!written || tenantId === undefined) return undefined;
  if (written[2] !== "credentials") return { tenantId, redeploy: REPO_SOURCES };
  const credentialId = written[3] === undefined ? undefined : decoded(written[3]);
  const name = await credentialName(db, req, tenantId, credentialId);
  return { tenantId, redeploy: name === undefined ? REPO_SOURCES : credentialHosts(name) };
}

export type ListenerWatchDeps = {
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  listener: (tenantId: string, source: RepoSource) => Promise<unknown>;
  ensure: (tenantId: string) => void;
};

/** Rolls a workspace once a connected host has no live listener, as after one stopped on its own. */
export function createListenerWatch(deps: ListenerWatchDeps) {
  return async function watch(tenantId: string): Promise<void> {
    for (const source of await deps.connectedSources(tenantId)) {
      if (await deps.listener(tenantId, source)) continue;
      deps.ensure(tenantId);
      return;
    }
  };
}
