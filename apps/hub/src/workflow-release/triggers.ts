// What starts a roll besides the hub's own start: a write through a stock route, a host found with no listener, and one whose
// listener the hub cannot route mail to, including one whose deploy or sidecar restore misses the start deadline or whose sidecar stays disconnected past the deployment's limit.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { SidecarIdentityValidationError, SidecarNotConnectedError, type AllocatedSidecarTarget } from "@intx/hub-sessions";
import { asRecord, decodedSegment, errorText } from "@corbits/common";
import { REPO_SOURCES, type RepoSource } from "@corbits/triage-contracts";
import { START_DEADLINE_MS } from "./rollout.js";

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
  /** The allocation generation the listener runs on once deployed, and how long its sidecar may stay disconnected; undefined while its deploy or sidecar restore has not finished. */
  allocation: (runId: string) => Promise<(AllocatedSidecarTarget & { readonly maxDisconnectedMs: number }) | undefined>;
  /** Stock's router: whether it routes the generation's mail. */
  routable: (target: AllocatedSidecarTarget) => Promise<boolean>;
  ensure: (tenantId: string) => void;
  replace: (tenantId: string, source: RepoSource) => boolean;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * Rolls a workspace once a connected host has no live listener, as after one stopped on its own, and starts a host's
 * listener again once its deploy or sidecar restore has not finished within the five-minute start deadline, once its
 * sidecar is connected but the hub holds no route to it, or once the router reports that sidecar not connected for
 * longer than the deployment's max disconnected limit. Stock clears a deployment's public key while replacing its
 * sidecar and acts on a lost route only when a sidecar connects or reports a stop, and its disconnect clock never
 * starts while the allocation stays allocated, so a listener whose restore stalls or whose sidecar is gone would
 * otherwise stay live and unreachable. The router measures a disconnect from when this hub last lost the
 * generation's binding, or from its own start. One whose stop stock gave up on is reported on every pass. Any other
 * failed check leaves whether the sidecar is connected unknown, so it is logged and not counted.
 */
export function createListenerWatch(deps: ListenerWatchDeps) {
  const starting = new Map<string, { runId: string; since: Date }>();
  return async function watch(tenantId: string): Promise<void> {
    for (const source of await deps.connectedSources(tenantId)) {
      const host = `${tenantId}:${source}`;
      for (const runId of await deps.stuck(tenantId, source)) deps.log({ level: "warn", msg: "listener_cancel_stuck", tenantId, source, deployment: runId });
      const listener = await deps.listener(tenantId, source);
      if (!listener) {
        starting.delete(host);
        deps.ensure(tenantId);
        continue;
      }
      const target = await deps.allocation(listener.runId);
      if (!target) {
        const at = deps.now();
        const current = starting.get(host);
        const since = current?.runId === listener.runId ? current.since : at;
        starting.set(host, { runId: listener.runId, since });
        const unstartedMs = at.getTime() - since.getTime();
        if (unstartedMs <= START_DEADLINE_MS || !deps.replace(tenantId, source)) continue;
        deps.log({ level: "warn", msg: "listener_unroutable", tenantId, source, deployment: listener.runId, unstartedMs, reason: "its deploy or sidecar restore did not finish within five minutes" });
        continue;
      }
      starting.delete(host);
      const entry = { tenantId, source, deployment: listener.runId, allocationId: target.allocationId, generation: target.generation };
      let routed: boolean;
      try {
        routed = await deps.routable(target);
      } catch (error) {
        if (error instanceof SidecarIdentityValidationError) {
          deps.log({ level: "warn", msg: "listener_identity_unknown", ...entry, reason: errorText(error) });
          continue;
        }
        if (!(error instanceof SidecarNotConnectedError)) {
          deps.log({ level: "warn", msg: "listener_check_failed", ...entry, reason: errorText(error) });
          continue;
        }
        const unreachableMs = deps.now().getTime() - error.notConnectedSince.getTime();
        if (unreachableMs <= target.maxDisconnectedMs) {
          deps.log({ level: "debug", msg: "listener_disconnected", ...entry, reason: errorText(error) });
          continue;
        }
        if (!deps.replace(tenantId, source)) continue;
        deps.log({ level: "warn", msg: "listener_unreachable", ...entry, unreachableMs, reason: "its sidecar stayed disconnected longer than the deployment's limit" });
        continue;
      }
      if (routed || !deps.replace(tenantId, source)) continue;
      deps.log({ level: "warn", msg: "listener_unroutable", ...entry, reason: "its sidecar is connected but the hub holds no route to it" });
    }
  };
}
