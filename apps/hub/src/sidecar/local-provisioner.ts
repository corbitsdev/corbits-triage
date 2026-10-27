// One sidecar process on the hub's machine hosts every allocation placed here. The first ensure starts it under the
// identity the hub offered; every later ensure answers with that sidecar, which stock Interchange then deploys into
// over the same connection, up to the active deployments the sidecar advertises in its hello.
import fs from "node:fs/promises";
import path from "node:path";
import { errorText } from "@corbits/common";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
  SidecarProvisionerHost,
} from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { CAPACITY_UNAVAILABLE, shortfall, type HostCapacity } from "./host-capacity.js";
import type { LocalSidecarHold, LocalSidecarManifest, LocalSidecarManifestStore } from "./manifest-store.js";

const DEFAULT_STOP_TIMEOUT_MS = 25_000;
const DATA_DIR_NAME = "sidecar";

/** How the process ended: its exit code, or the signal that killed it. */
export type LocalSidecarExit = { readonly code: number | null; readonly signal: string | null };

interface LocalSidecarProcess {
  readonly pid: number;
  readonly exited: Promise<LocalSidecarExit>;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnLocalSidecar = (args: {
  readonly manifest: LocalSidecarManifest;
  readonly adapterManifest: AdapterManifest;
}) => LocalSidecarProcess;

export type CreateLocalProcessSidecarProvisionerOpts = {
  readonly dataRoot: string;
  readonly spawnSidecar: SpawnLocalSidecar;
  readonly manifests: LocalSidecarManifestStore;
  readonly capacity: HostCapacity;
  /** Operator config, so a respawned sidecar loads the hub's adapters, not the ones it first started with. */
  readonly adapterManifest: AdapterManifest;
  readonly stopTimeoutMs?: number;
  readonly log: (entry: Record<string, unknown>) => void;
};

export type LocalSidecarRecords = {
  /** Whether the hub still holds this allocation, at this generation, on the local sidecar. */
  isLive(hold: LocalSidecarHold & { readonly sidecarId: string }): Promise<boolean>;
  /** Whether the hub still has work on the sidecar, including copies it waits for the sidecar to remove. */
  hasWork(sidecarId: string): Promise<boolean>;
  /** Whether stock may still ensure this allocation or probe: one it ended is never ensured again. */
  isOpen(allocationId: string): Promise<boolean>;
};

export interface LocalProcessSidecarProvisioner {
  readonly provisioner: SidecarProvisioner;
  restore(records: LocalSidecarRecords): Promise<void>;
  shutdown(): Promise<void>;
}

type ManagedProcess = {
  readonly handle: LocalSidecarProcess;
  exited: boolean;
};

type HoldState =
  | ({ readonly kind: "live" } & LocalSidecarHold)
  | {
      readonly kind: "destroyed";
      readonly generation: number;
      /** The identities a late ensure at this generation may still carry. */
      readonly sidecarIds: readonly string[];
    };

async function waitForExit(managed: ManagedProcess): Promise<true> {
  await managed.handle.exited;
  return true;
}

async function exitedWithin(managed: ManagedProcess, timeoutMs: number): Promise<boolean> {
  if (managed.exited) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(function scheduleTimeout(resolve) {
    timer = setTimeout(resolve, timeoutMs, false);
  });
  try {
    return await Promise.race([waitForExit(managed), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function settle(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller observes the failure; the queue only needs ordering.
  }
}

export function createLocalProcessSidecarProvisioner({
  dataRoot,
  spawnSidecar,
  manifests,
  capacity,
  adapterManifest,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  log,
}: CreateLocalProcessSidecarProvisionerOpts): LocalProcessSidecarProvisioner {
  if (stopTimeoutMs <= 0) {
    throw new Error("Local sidecar stop timeout must be positive");
  }

  const dataDir = path.join(dataRoot, DATA_DIR_NAME);
  const holds = new Map<string, HoldState>();
  let manifest: LocalSidecarManifest | null = null;
  let running: ManagedProcess | null = null;
  let queue: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | null = null;
  let host: SidecarProvisionerHost | undefined;

  // Every operation runs alone: the sidecar starts once, and the holds file is written whole.
  async function serialize<R, T>(request: R, run: (request: R) => Promise<T>): Promise<T> {
    if (shutdownPromise !== null) {
      throw new Error("Local sidecar provisioner is shutting down");
    }
    const previous = queue;
    const pending = runAfter(previous, request, run);
    queue = settle(pending);
    return pending;
  }

  async function runAfter<R, T>(previous: Promise<void>, request: R, run: (request: R) => Promise<T>): Promise<T> {
    await previous;
    return run(request);
  }

  async function persistHolds(): Promise<void> {
    const live = [...holds.values()].flatMap((state) =>
      state.kind === "live" ? [{ allocationId: state.allocationId, generation: state.generation, offeredSidecarId: state.offeredSidecarId }] : []);
    await manifests.writeHolds(live);
  }

  // The hub never repeats a destroy, so a fence only memory held would let a late ensure through after a restart.
  async function persistFences(): Promise<void> {
    const fences = [...holds.entries()].flatMap(([allocationId, state]) =>
      state.kind === "destroyed" ? [{ allocationId, generation: state.generation, sidecarIds: [...state.sidecarIds] }] : []);
    await manifests.writeFences(fences);
  }

  // One exit takes down every deployment the sidecar hosts, so each is logged.
  async function trackExit(managed: ManagedProcess, sidecarId: string): Promise<void> {
    try {
      const { code, signal } = await managed.handle.exited;
      log({ level: shutdownPromise === null ? "error" : "info", msg: "local_sidecar_exited", sidecarId, pid: managed.handle.pid, code, signal });
    } finally {
      managed.exited = true;
    }
  }

  function start(current: LocalSidecarManifest): ManagedProcess {
    const managed: ManagedProcess = { handle: spawnSidecar({ manifest: current, adapterManifest }), exited: false };
    void trackExit(managed, current.sidecarId);
    running = managed;
    return managed;
  }

  /** The running sidecar, started under `request`'s identity when none was minted yet. */
  async function sidecarFor(request: EnsureSidecarRequest): Promise<
    | { readonly kind: "running"; readonly manifest: LocalSidecarManifest; readonly process: ManagedProcess }
    | Extract<EnsureSidecarResult, { kind: "rejected" }>
  > {
    if (manifest !== null && running !== null && !running.exited) {
      return { kind: "running", manifest, process: running };
    }
    const full = shortfall(await capacity.freeBytes());
    if (full !== undefined) {
      return { kind: "rejected", code: CAPACITY_UNAVAILABLE, message: full, retryable: true };
    }
    request.signal?.throwIfAborted();
    const minted = manifest === null;
    const current = manifest ?? { sidecarId: request.sidecarId, token: request.token, hubWebSocketUrl: request.hubWebSocketUrl, dataDir };
    try {
      if (minted) {
        await fs.mkdir(dataDir, { recursive: true });
        await manifests.write(current);
        manifest = current;
      }
      const child = start(current);
      log({ level: "info", msg: minted ? "local_sidecar_started" : "local_sidecar_respawned", sidecarId: current.sidecarId, pid: child.handle.pid });
      return { kind: "running", manifest: current, process: child };
    } catch (error) {
      // A rejected ensure retires the identity it was offered, so a sidecar minted from it must not outlive it.
      if (minted) {
        manifest = null;
        await manifests.remove();
      }
      return { kind: "rejected", code: "spawn_failed", message: errorText(error), retryable: true };
    }
  }

  async function ensureAllocation(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const existing = holds.get(request.allocationId);
    if (existing !== undefined && existing.generation > request.generation) {
      return {
        kind: "rejected",
        code: "stale_generation",
        message: `Generation ${String(request.generation)} is older than ${String(existing.generation)}`,
        retryable: false,
      };
    }
    // Replacement destroys the old copy at the new generation before ensuring a fresh identity at that same
    // generation. Fence only the identities that destroy named.
    if (existing?.kind === "destroyed" && existing.generation === request.generation && existing.sidecarIds.includes(request.sidecarId)) {
      return {
        kind: "rejected",
        code: "generation_destroyed",
        message: `Generation ${String(request.generation)} was already destroyed`,
        retryable: false,
      };
    }
    if (existing?.kind === "live" && existing.generation === request.generation && existing.offeredSidecarId !== request.sidecarId) {
      return {
        kind: "rejected",
        code: "sidecar_identity_conflict",
        message: `Generation ${String(request.generation)} already belongs to another sidecar identity`,
        retryable: false,
      };
    }
    const sidecar = await sidecarFor(request);
    if (sidecar.kind === "rejected") return sidecar;
    holds.set(request.allocationId, { kind: "live", allocationId: request.allocationId, generation: request.generation, offeredSidecarId: request.sidecarId });
    await persistHolds();
    if (existing?.kind === "destroyed") await persistFences();
    return {
      kind: "accepted",
      externalRef: String(sidecar.process.handle.pid),
      ...(sidecar.manifest.sidecarId !== request.sidecarId && { sidecarId: sidecar.manifest.sidecarId }),
    };
  }

  // The sidecar outlives every hold, so its copy of the allocation is removed by the hub over its connection, which
  // confirms the cleanup. An identity that is not the sidecar's was only offered: nothing was deployed under it.
  async function destroyAllocation(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const existing = holds.get(request.allocationId);
    // A destroy older than the allocation's hold is for a copy a newer generation already replaced, so the live hold
    // stays. Its answer is still `required` for the sidecar's id: stock retires an identity whose cleanup a destroy
    // confirms, which would stop every placement on the sidecar, and the undeploy it leads to removes only
    // incarnations up to the destroy's generation, never the live one.
    const stale = existing !== undefined && existing.generation > request.generation;
    if (!stale) {
      const sidecarIds = existing?.kind === "live" ? [request.sidecarId, existing.offeredSidecarId] : [request.sidecarId];
      holds.set(request.allocationId, { kind: "destroyed", generation: request.generation, sidecarIds });
      await persistFences();
      if (existing?.kind === "live") await persistHolds();
    }
    return { kind: "destroyed", cleanup: request.sidecarId === manifest?.sidecarId ? "required" : "confirmed" };
  }

  function attached(): SidecarProvisionerHost {
    if (host === undefined) throw new Error("Local sidecar provisioner is not attached to the hub");
    return host;
  }

  // A hub that ran one sidecar per allocation stopped them all at shutdown, and none comes back. Retiring each identity
  // gives its allocations no reconnect window, so the reconciler replaces them at once; a sidecar the hub could not
  // retire keeps its files for the next boot to try again.
  async function retireLegacySidecars(): Promise<void> {
    const legacy = await manifests.legacySidecars();
    const kept = new Set<string>();
    if (legacy.length > 0) {
      const hub = attached();
      for (const { allocationId, sidecarId } of legacy) {
        try {
          await hub.sidecarStopped(sidecarId, { endReconnectWindow: true });
        } catch (error) {
          kept.add(allocationId);
          log({ level: "warn", msg: "local_sidecar_legacy_retire_failed", allocationId, sidecarId, error: errorText(error) });
        }
      }
    }
    const removed = await manifests.removeLegacyLayout(kept);
    if (removed.length > 0) log({ level: "info", msg: "local_sidecar_legacy_layout_removed", retired: legacy.length - kept.size, removed });
  }

  // Ensure or destroy may reach an allocation before restore does; their outcome wins.
  async function restoreFences(isOpen: LocalSidecarRecords["isOpen"]): Promise<void> {
    const stored = await manifests.readFences();
    for (const fence of stored) {
      if (holds.has(fence.allocationId) || !(await isOpen(fence.allocationId))) continue;
      holds.set(fence.allocationId, { kind: "destroyed", generation: fence.generation, sidecarIds: fence.sidecarIds });
    }
    if (stored.length > 0) await persistFences();
  }

  async function forget(): Promise<void> {
    await manifests.remove();
    await manifests.writeHolds([]);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  // A copy whose hold a destroy released is removed only once the sidecar reconnects and the hub undeploys it, so the
  // sidecar comes back for that cleanup too; forgetting it would leave the copy holding a slot for good.
  async function restoreSidecar({ isLive, hasWork, isOpen }: LocalSidecarRecords): Promise<void> {
    await retireLegacySidecars();
    await restoreFences(isOpen);
    const stored = await manifests.read();
    const recorded = await manifests.readHolds();
    if (stored === null) {
      if (recorded.length > 0) await forget();
      return;
    }
    const live: LocalSidecarHold[] = [];
    for (const hold of recorded) {
      if (await isLive({ ...hold, sidecarId: stored.sidecarId })) live.push(hold);
    }
    const dropped = recorded.length - live.length;
    if (live.length === 0 && !(await hasWork(stored.sidecarId))) {
      await forget();
      log({ level: "info", msg: "local_sidecar_removed", sidecarId: stored.sidecarId, dropped });
      return;
    }
    manifest = stored;
    for (const hold of live) holds.set(hold.allocationId, { kind: "live", ...hold });
    await manifests.writeHolds(live);
    const child = start(stored);
    log({ level: "info", msg: "local_sidecar_respawned", sidecarId: stored.sidecarId, pid: child.handle.pid, holds: live.length, dropped });
  }

  async function stopProcess(managed: ManagedProcess): Promise<void> {
    if (managed.exited) return;
    try {
      managed.handle.kill("SIGTERM");
    } catch (error) {
      if (!managed.exited) throw error;
    }
    if (await exitedWithin(managed, stopTimeoutMs)) return;
    managed.handle.kill("SIGKILL");
    if (!(await exitedWithin(managed, stopTimeoutMs))) {
      throw new Error(`Local sidecar process ${String(managed.handle.pid)} did not exit`);
    }
  }

  // The manifest, holds and data dir survive shutdown so the next hub boot can respawn the sidecar.
  async function stopAll(): Promise<void> {
    await queue;
    if (running !== null) await stopProcess(running);
    running = null;
  }

  const provisioner: SidecarProvisioner = {
    id: "local-process",
    apiVersion: 2,
    bindingFingerprint: "local-process:v1",
    capabilities: [],
    attach(hub) {
      host = hub;
    },
    ensure(request) {
      return serialize(request, ensureAllocation);
    },
    destroy(request) {
      return serialize(request, destroyAllocation);
    },
  };

  return {
    provisioner,
    restore(records) {
      return serialize(records, restoreSidecar);
    },
    shutdown() {
      shutdownPromise ??= stopAll();
      return shutdownPromise;
    },
  };
}
