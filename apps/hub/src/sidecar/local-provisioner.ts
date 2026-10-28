// One sidecar process on the hub's machine per allocation, as stock's own harness runs them
// (vendor/interchange/tests/admin-ui-e2e/harness/local-process-sidecar-provisioner.ts): ensure starts it, destroy
// stops it and removes its files. A sidecar process keeps memory for every deployment it hosted, so none outlives the
// allocation it was started for, and none outlives the hub: boot retires every sidecar an earlier boot started.
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
import type { LocalSidecarManifest, LocalSidecarManifestStore } from "./manifest-store.js";

const DEFAULT_STOP_TIMEOUT_MS = 25_000;

/** How the process ended: its exit code, or the signal that killed it. */
export type LocalSidecarExit = { readonly code: number | null; readonly signal: string | null };

interface LocalSidecarProcess {
  readonly pid: number;
  readonly exited: Promise<LocalSidecarExit>;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnLocalSidecar = (args: {
  readonly sidecarId: string;
  readonly token: string;
  readonly hubWebSocketUrl: string;
  readonly dataDir: string;
  readonly adapterManifest: AdapterManifest;
}) => LocalSidecarProcess;

export type CreateLocalProcessSidecarProvisionerOpts = {
  readonly dataRoot: string;
  readonly spawnSidecar: SpawnLocalSidecar;
  readonly manifests: LocalSidecarManifestStore;
  readonly capacity: HostCapacity;
  /** Operator config: the adapters each sidecar loads. */
  readonly adapterManifest: AdapterManifest;
  /** The sidecar processes that may run at once. */
  readonly maxSidecars: number;
  readonly stopTimeoutMs?: number;
  readonly log: (entry: Record<string, unknown>) => void;
};

export type LocalSidecarRecords = {
  /** Those of these allocations and probes stock may still ensure: one it ended is never ensured again. */
  stillOpen(allocationIds: readonly string[]): Promise<ReadonlySet<string>>;
};

export interface LocalProcessSidecarProvisioner {
  readonly provisioner: SidecarProvisioner;
  boot(records: LocalSidecarRecords): Promise<void>;
  /** The hub saw this allocation's sidecar connect, so its memory now shows in the box's own figures. */
  connected(allocation: { readonly allocationId: string; readonly generation: number }): void;
  shutdown(): Promise<void>;
}

type ManagedProcess = {
  readonly handle: LocalSidecarProcess;
  exited: boolean;
  /** Stopped by the provisioner, so its exit is no crash. */
  stopping: boolean;
};

type LiveSidecar = LocalSidecarManifest & { readonly process: ManagedProcess };

/** A destroyed generation of an allocation, and the identities a late ensure at it may still carry. */
type Fence = { readonly generation: number; readonly sidecarIds: readonly string[] };

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

function startingKey({ allocationId, generation }: { readonly allocationId: string; readonly generation: number }): string {
  return `${allocationId}@${String(generation)}`;
}

export function createLocalProcessSidecarProvisioner({
  dataRoot,
  spawnSidecar,
  manifests,
  capacity,
  adapterManifest,
  maxSidecars,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  log,
}: CreateLocalProcessSidecarProvisionerOpts): LocalProcessSidecarProvisioner {
  if (stopTimeoutMs <= 0) {
    throw new Error("Local sidecar stop timeout must be positive");
  }

  const live = new Map<string, LiveSidecar>();
  const fences = new Map<string, Fence>();
  /** Allocations past the cap check whose sidecar is not in `live` yet, so ensures side by side each count the others. */
  const reserved = new Set<string>();
  /** Sidecars started and not yet connected or exited, by allocation and generation. */
  const starting = new Set<string>();
  const operations = new Map<string, Promise<void>>();
  let shutdownPromise: Promise<void> | null = null;
  let host: SidecarProvisionerHost | undefined;
  let records: LocalSidecarRecords | undefined;
  // Ensure and destroy wait for boot to retire the sidecars earlier boots started; a failed boot fails them rather than
  // letting an ensure start a sidecar beside ones the hub still counts.
  const booted = Promise.withResolvers<void>();
  void settle(booted.promise);

  async function runAfter<R, T>(previous: Promise<void> | undefined, request: R, run: (request: R) => Promise<T>): Promise<T> {
    await previous;
    return run(request);
  }

  async function releaseWhenSettled(allocationId: string, settled: Promise<void>): Promise<void> {
    await settled;
    if (operations.get(allocationId) === settled) operations.delete(allocationId);
  }

  // Operations on one allocation run in order, so cleanup stays behind a late ensure stock stopped awaiting.
  async function serialize<R extends { readonly allocationId: string }, T>(request: R, run: (request: R) => Promise<T>): Promise<T> {
    if (shutdownPromise !== null) {
      throw new Error("Local sidecar provisioner is shutting down");
    }
    const pending = runAfter(operations.get(request.allocationId), request, run);
    const settled = settle(pending);
    operations.set(request.allocationId, settled);
    void releaseWhenSettled(request.allocationId, settled);
    return pending;
  }

  function attached(): SidecarProvisionerHost {
    if (host === undefined) throw new Error("Local sidecar provisioner is not attached to the hub");
    return host;
  }

  function bootRecords(): LocalSidecarRecords {
    if (records === undefined) throw new Error("Local sidecar provisioner has not booted");
    return records;
  }

  // An allocation stock ended is never ensured again, and an ensure for one is refused anyway, so its fence goes.
  async function pruneFences(): Promise<void> {
    const open = await bootRecords().stillOpen([...fences.keys()]);
    for (const allocationId of fences.keys()) if (!open.has(allocationId)) fences.delete(allocationId);
  }

  async function stopProcess(managed: ManagedProcess): Promise<void> {
    managed.stopping = true;
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

  async function removeStored(sidecar: LocalSidecarManifest): Promise<void> {
    await manifests.remove(sidecar.allocationId);
    await fs.rm(sidecar.dataDir, { recursive: true, force: true });
  }

  async function stopAndRemove(sidecar: LiveSidecar): Promise<void> {
    await stopProcess(sidecar.process);
    if (live.get(sidecar.allocationId) === sidecar) live.delete(sidecar.allocationId);
    await removeStored(sidecar);
  }

  // Retired at once, so its work is placed again without waiting out a reconnect window.
  async function retireExited(sidecar: LiveSidecar): Promise<void> {
    if (live.get(sidecar.allocationId) !== sidecar) return;
    live.delete(sidecar.allocationId);
    await attached().sidecarStopped(sidecar.sidecarId, { endReconnectWindow: true });
    await removeStored(sidecar);
    log({ level: "warn", msg: "local_sidecar_retired", allocationId: sidecar.allocationId, sidecarId: sidecar.sidecarId });
  }

  async function trackExit(sidecar: LiveSidecar): Promise<void> {
    const managed = sidecar.process;
    try {
      const { code, signal } = await managed.handle.exited;
      if (!managed.stopping) log({ level: "error", msg: "local_sidecar_exited", allocationId: sidecar.allocationId, sidecarId: sidecar.sidecarId, pid: managed.handle.pid, code, signal });
    } finally {
      managed.exited = true;
      starting.delete(startingKey(sidecar));
    }
    if (managed.stopping || shutdownPromise !== null) return;
    try {
      await serialize(sidecar, retireExited);
    } catch (error) {
      log({ level: "error", msg: "local_sidecar_retire_failed", allocationId: sidecar.allocationId, sidecarId: sidecar.sidecarId, error: errorText(error) });
    }
  }

  /** Why no further sidecar can start now, or undefined while one can. */
  function noRoom(free: number | undefined): string | undefined {
    if (live.size + reserved.size >= maxSidecars) return `${String(maxSidecars)} local sidecars already run`;
    return shortfall(free, starting.size);
  }

  async function ensureAllocation(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const existing = live.get(request.allocationId);
    const fence = fences.get(request.allocationId);
    const newest = existing?.generation ?? fence?.generation;
    if (newest !== undefined && newest > request.generation) {
      return {
        kind: "rejected",
        code: "stale_generation",
        message: `Generation ${String(request.generation)} is older than ${String(newest)}`,
        retryable: false,
      };
    }
    // Replacement destroys the old identity at the new generation before ensuring a fresh identity at that same
    // generation. Fence only the identities that destroy named.
    if (existing === undefined && fence !== undefined && fence.generation === request.generation && fence.sidecarIds.includes(request.sidecarId)) {
      return {
        kind: "rejected",
        code: "generation_destroyed",
        message: `Generation ${String(request.generation)} was already destroyed`,
        retryable: false,
      };
    }
    if (existing !== undefined && existing.generation === request.generation) {
      if (existing.sidecarId !== request.sidecarId) {
        return {
          kind: "rejected",
          code: "sidecar_identity_conflict",
          message: `Generation ${String(request.generation)} already belongs to another sidecar identity`,
          retryable: false,
        };
      }
      return { kind: "accepted", externalRef: String(existing.process.handle.pid) };
    }
    if (existing !== undefined) await stopAndRemove(existing);
    // Checked and counted in one turn, so ensures running side by side each see the others.
    const full = noRoom(await capacity.freeBytes());
    if (full !== undefined) {
      log({ level: "warn", msg: "local_sidecar_refused", allocationId: request.allocationId, reason: full });
      return { kind: "rejected", code: CAPACITY_UNAVAILABLE, message: full, retryable: true };
    }
    reserved.add(request.allocationId);
    let dataDir: string | undefined;
    let started: LiveSidecar | undefined;
    try {
      await fs.mkdir(dataRoot, { recursive: true });
      dataDir = await fs.mkdtemp(path.join(dataRoot, `${request.allocationId}-`));
      const stored = { allocationId: request.allocationId, generation: request.generation, sidecarId: request.sidecarId, dataDir };
      await manifests.write(stored);
      request.signal?.throwIfAborted();
      const handle = spawnSidecar({ sidecarId: request.sidecarId, token: request.token, hubWebSocketUrl: request.hubWebSocketUrl, dataDir, adapterManifest });
      started = { ...stored, process: { handle, exited: false, stopping: false } };
      live.set(request.allocationId, started);
      starting.add(startingKey(request));
      fences.delete(request.allocationId);
      void trackExit(started);
      log({ level: "info", msg: "local_sidecar_started", allocationId: request.allocationId, sidecarId: request.sidecarId, pid: handle.pid });
      return { kind: "accepted", externalRef: String(handle.pid) };
    } catch (error) {
      if (started !== undefined) await stopAndRemove(started);
      else if (dataDir !== undefined) await removeStored({ allocationId: request.allocationId, generation: request.generation, sidecarId: request.sidecarId, dataDir });
      return { kind: "rejected", code: "spawn_failed", message: errorText(error), retryable: true };
    } finally {
      reserved.delete(request.allocationId);
    }
  }

  // Each allocation runs in its own process, so stopping it removes every copy it hosted and cleanup is confirmed.
  async function destroyAllocation(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const existing = live.get(request.allocationId);
    const fence = fences.get(request.allocationId);
    const newest = existing?.generation ?? fence?.generation;
    // A destroy older than the allocation's sidecar or fence is for one a newer generation already replaced.
    if (newest !== undefined && newest > request.generation) return { kind: "destroyed", cleanup: "confirmed" };
    // A late destroy naming a superseded identity must not stop the replacement that owns the generation now.
    if (existing !== undefined && existing.sidecarId !== request.sidecarId) return { kind: "destroyed", cleanup: "confirmed" };
    if (existing !== undefined) await stopAndRemove(existing);
    const earlier = fence?.generation === request.generation ? fence.sidecarIds : [];
    const sidecarIds = [...new Set([...earlier, request.sidecarId, ...(existing === undefined ? [] : [existing.sidecarId])])];
    fences.set(request.allocationId, { generation: request.generation, sidecarIds });
    await pruneFences();
    return { kind: "destroyed", cleanup: "confirmed" };
  }

  // A sidecar an earlier boot started is never brought back: stock places its work again on a fresh one. One the hub
  // could not retire fails boot and keeps its manifest, so the next boot retries it.
  async function bootSidecars(booting: LocalSidecarRecords): Promise<void> {
    records = booting;
    const listed = await manifests.listed();
    for (const sidecarId of listed) await attached().sidecarStopped(sidecarId, { endReconnectWindow: true });
    await manifests.clear();
    if (listed.length > 0) log({ level: "info", msg: "local_sidecars_retired_at_boot", sidecarIds: listed });
  }

  async function bootOnce(booting: LocalSidecarRecords): Promise<void> {
    try {
      await bootSidecars(booting);
      booted.resolve();
    } catch (error) {
      booted.reject(error);
      throw error;
    }
  }

  // Manifests survive shutdown so the next boot can retire their sidecars.
  async function stopAll(): Promise<void> {
    await Promise.all(operations.values());
    const results = await Promise.allSettled([...live.values()].map((sidecar) => stopProcess(sidecar.process)));
    live.clear();
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to stop every local sidecar process");
  }

  const provisioner: SidecarProvisioner = {
    id: "local-process",
    apiVersion: 2,
    bindingFingerprint: "local-process:v1",
    capabilities: [],
    attach(hub) {
      host = hub;
    },
    async ensure(request) {
      await booted.promise;
      return serialize(request, ensureAllocation);
    },
    async destroy(request) {
      await booted.promise;
      return serialize(request, destroyAllocation);
    },
  };

  return {
    provisioner,
    boot: bootOnce,
    connected(allocation) {
      starting.delete(startingKey(allocation));
    },
    shutdown() {
      shutdownPromise ??= stopAll();
      return shutdownPromise;
    },
  };
}
