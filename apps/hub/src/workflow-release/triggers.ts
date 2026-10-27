// What starts a roll besides the hub's own start: a write through a stock route, a host found with no listener, and one whose
// listener the hub cannot route mail to.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { SidecarIdentityValidationError, type AllocatedSidecarTarget } from "@intx/hub-sessions";
import { asRecord, errorText } from "@corbits/common";
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
  listener: (tenantId: string, source: RepoSource) => Promise<{ runId: string } | undefined>;
  /** The host's listeners whose stop stock gave up on while they stay live. */
  stuck: (tenantId: string, source: RepoSource) => Promise<string[]>;
  /** The allocation generation the listener runs on once deployed; undefined while it starts. */
  allocation: (runId: string) => Promise<AllocatedSidecarTarget | undefined>;
  /** Stock's router: whether it routes the generation's mail. */
  routable: (target: AllocatedSidecarTarget) => Promise<boolean>;
  ensure: (tenantId: string) => void;
  replace: (tenantId: string, source: RepoSource) => boolean;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * Rolls a workspace once a connected host has no live listener, as after one stopped on its own, and starts a host's
 * listener again once its sidecar is connected but the hub holds no route to it. Stock acts on a lost route only when a
 * sidecar connects or reports a stop, so such a listener would otherwise stay live and unreachable. A listener whose
 * sidecar is not connected is left to stock, which fails it once it stays away past its deployment's limit. A listener
 * whose stop stock gave up on is reported on every pass.
 */
export function createListenerWatch(deps: ListenerWatchDeps) {
  return async function watch(tenantId: string): Promise<void> {
    for (const source of await deps.connectedSources(tenantId)) {
      for (const runId of await deps.stuck(tenantId, source)) deps.log({ level: "warn", msg: "listener_cancel_stuck", tenantId, source, deployment: runId });
      const listener = await deps.listener(tenantId, source);
      if (!listener) {
        deps.ensure(tenantId);
        return;
      }
      const target = await deps.allocation(listener.runId);
      if (!target) continue;
      const entry = { tenantId, source, deployment: listener.runId, allocationId: target.allocationId, generation: target.generation };
      let routed: boolean;
      try {
        routed = await deps.routable(target);
      } catch (error) {
        // A failed identity lookup leaves whether the sidecar is connected unknown, not absent.
        if (error instanceof SidecarIdentityValidationError) deps.log({ level: "warn", msg: "listener_identity_unknown", ...entry, reason: errorText(error) });
        else deps.log({ level: "debug", msg: "listener_disconnected", ...entry, reason: errorText(error) });
        continue;
      }
      if (routed || !deps.replace(tenantId, source)) continue;
      deps.log({ level: "warn", msg: "listener_unroutable", ...entry, reason: "its sidecar is connected but the hub holds no route to it" });
    }
  };
}
