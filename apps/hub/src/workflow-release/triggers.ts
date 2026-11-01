// What starts a roll besides the hub's own start: a write through a stock route, a host found with no listener, and one whose
// listener the hub cannot route mail to, including one whose sidecar stays disconnected past the deployment's limit.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { SidecarIdentityValidationError, type AllocatedSidecarTarget } from "@intx/hub-sessions";
import { asRecord, decodedSegment, errorText } from "@corbits/common";
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
  const tenantId = written ? decodedSegment(written[1]!) : undefined;
  if (!written || tenantId === undefined) return undefined;
  if (written[2] !== "credentials") return { tenantId, redeploy: REPO_SOURCES };
  const credentialId = written[3] === undefined ? undefined : decodedSegment(written[3]);
  const name = await credentialName(db, req, tenantId, credentialId);
  return { tenantId, redeploy: name === undefined ? REPO_SOURCES : credentialHosts(name) };
}

export type ListenerWatchDeps = {
  connectedSources: (tenantId: string) => Promise<RepoSource[]>;
  listener: (tenantId: string, source: RepoSource) => Promise<{ runId: string } | undefined>;
  /** The host's listeners whose stop stock gave up on while they stay live. */
  stuck: (tenantId: string, source: RepoSource) => Promise<string[]>;
  /** The allocation generation the listener runs on once deployed, and how long its sidecar may stay disconnected; undefined while it starts. */
  allocation: (runId: string) => Promise<(AllocatedSidecarTarget & { readonly maxDisconnectedMs: number }) | undefined>;
  /** Stock's router: whether it routes the generation's mail. */
  routable: (target: AllocatedSidecarTarget) => Promise<boolean>;
  ensure: (tenantId: string) => void;
  replace: (tenantId: string, source: RepoSource) => boolean;
  /** When a disconnect is measured. The clock is not kept across a restart of this process. */
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/** One listener generation, so a replacement starts its own disconnect clock. */
function disconnectKey(tenantId: string, source: RepoSource, runId: string, target: AllocatedSidecarTarget): string {
  return [tenantId, source, runId, target.allocationId, String(target.generation)].join("\0");
}

/**
 * Rolls a workspace once a connected host has no live listener, as after one stopped on its own, and starts a host's
 * listener again once its sidecar is connected but the hub holds no route to it, or once this watch has seen that
 * sidecar disconnected for longer than the deployment's max disconnected limit. Stock acts on a lost route only when a
 * sidecar connects or reports a stop, and its disconnect clock never starts while the allocation stays allocated, so a
 * listener whose sidecar is gone would otherwise stay live and unreachable. The clock is this watch's: a restart starts
 * it again, and a check that finds the sidecar connected clears it, so a brief disconnect does not replace the listener.
 * One whose stop stock gave up on is reported on every pass. A failed identity lookup leaves whether the sidecar is
 * connected unknown.
 */
export function createListenerWatch(deps: ListenerWatchDeps) {
  const unreachableSince = new Map<string, number>();
  return async function watch(tenantId: string): Promise<void> {
    for (const source of await deps.connectedSources(tenantId)) {
      for (const runId of await deps.stuck(tenantId, source)) deps.log({ level: "warn", msg: "listener_cancel_stuck", tenantId, source, deployment: runId });
      const listener = await deps.listener(tenantId, source);
      if (!listener) {
        deps.ensure(tenantId);
        continue;
      }
      const target = await deps.allocation(listener.runId);
      if (!target) continue;
      const entry = { tenantId, source, deployment: listener.runId, allocationId: target.allocationId, generation: target.generation };
      const key = disconnectKey(tenantId, source, listener.runId, target);
      let routed: boolean;
      try {
        routed = await deps.routable(target);
      } catch (error) {
        // A failed identity lookup leaves whether the sidecar is connected unknown, not absent.
        if (error instanceof SidecarIdentityValidationError) {
          deps.log({ level: "warn", msg: "listener_identity_unknown", ...entry, reason: errorText(error) });
          continue;
        }
        const at = deps.now().getTime();
        const since = unreachableSince.get(key);
        if (since === undefined) unreachableSince.set(key, at);
        const unreachableMs = at - (since ?? at);
        if (unreachableMs <= target.maxDisconnectedMs) {
          deps.log({ level: "debug", msg: "listener_disconnected", ...entry, reason: errorText(error) });
          continue;
        }
        if (!deps.replace(tenantId, source)) continue;
        deps.log({ level: "warn", msg: "listener_unreachable", ...entry, unreachableMs, reason: "its sidecar stayed disconnected longer than the deployment's limit" });
        continue;
      }
      unreachableSince.delete(key);
      if (routed || !deps.replace(tenantId, source)) continue;
      deps.log({ level: "warn", msg: "listener_unroutable", ...entry, reason: "its sidecar is connected but the hub holds no route to it" });
    }
  };
}
