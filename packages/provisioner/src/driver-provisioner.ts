import { errorText } from "@corbits/common";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import type { SidecarCapabilityDeclaration } from "@intx/types";
import { buildSidecarEnv, type SidecarEnv, type SidecarLaunchSpec } from "./sidecar-env.js";

/** One allocation's capacity as the backend itself records it, so it is found again after a hub restart. */
export type SidecarHandle = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly tenantId: string;
  readonly externalRef: string;
  readonly running: boolean;
  /** When the backend started this capacity; absent when it cannot know (a local record whose process is gone). */
  readonly startedAt?: Date;
};

/** Operator limits on one driver. Unset means unbounded. */
export type SidecarDriverLimits = {
  /** Running allocations at once; a new one beyond it is refused as retryable `capacity_full`. */
  readonly maxAllocations?: number;
};

/** One allocation's capacity from start to stop, for cost attribution. */
export type SidecarUsage = {
  readonly driverId: string;
  readonly tenantId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly startedAt: Date;
  readonly stoppedAt: Date;
  readonly runtimeMs: number;
};

/**
 * A backend that runs one sidecar per allocation. Capabilities are the
 * guarantees it keeps (stock capability names, see the repository's docs/SIDECAR_DRIVERS.md), never a vendor or a location.
 */
export interface SidecarDriver {
  readonly id: string;
  /** Stable and non-secret; a change orphans the allocations placed under the old value. */
  readonly fingerprint: string;
  readonly capabilities: readonly SidecarCapabilityDeclaration[];
  readonly limits: SidecarDriverLimits;
  /** Starts the sidecar with exactly `env`. A throw must leave nothing behind that `find` cannot see. */
  start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle>;
  /** Idempotent: capacity already gone is not an error. */
  stop(handle: SidecarHandle): Promise<void>;
  /** The allocation's newest capacity, running or not, or null when it has none. */
  find(allocationId: string): Promise<SidecarHandle | null>;
  /** Every allocation's capacity this driver holds, running or not. */
  list(): Promise<readonly SidecarHandle[]>;
}

export type DriverProvisioner = {
  readonly provisioner: SidecarProvisioner;
  /** The environment a sidecar of this driver starts with. */
  envFor(launch: SidecarLaunchSpec): SidecarEnv;
  /** Runs `operation` in the allocation's queue, ordered with its ensure and destroy calls. */
  exclusive<T>(allocationId: string, operation: () => Promise<T>): Promise<T>;
  /** False when the driver's `maxAllocations` are all running. */
  hasRoom(): Promise<boolean>;
  /** Refuses new operations and waits for the ones in flight. */
  drain(): Promise<void>;
};

export type DriverProvisionerOpts = {
  readonly credentialEncryptionKey: string;
  readonly onUsage: (usage: SidecarUsage) => void;
};

type Fence = {
  readonly generation: number;
  readonly sidecarId: string;
  readonly destroyed: boolean;
};

function rejected(code: string, message: string, retryable: boolean): EnsureSidecarResult {
  return { kind: "rejected", code, message, retryable };
}

async function settle(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller observes the failure; the per-allocation queue only needs ordering.
  }
}

async function after<T>(previous: Promise<void> | undefined, operation: () => Promise<T>): Promise<T> {
  await previous;
  return operation();
}

/** Implements the stock provisioner contract (idempotency, generation fencing, ordering) once for every driver. */
export function createDriverProvisioner(driver: SidecarDriver, { credentialEncryptionKey, onUsage }: DriverProvisionerOpts): DriverProvisioner {
  const fences = new Map<string, Fence>();
  const queues = new Map<string, Promise<void>>();
  let admissions: Promise<void> = Promise.resolve();
  let draining = false;

  async function release(allocationId: string, settled: Promise<void>): Promise<void> {
    await settled;
    if (queues.get(allocationId) === settled) queues.delete(allocationId);
  }

  function exclusive<T>(allocationId: string, operation: () => Promise<T>): Promise<T> {
    if (draining) return Promise.reject(new Error(`Sidecar driver ${driver.id} is shutting down`));
    const pending = after(queues.get(allocationId), operation);
    const settled = settle(pending);
    queues.set(allocationId, settled);
    void release(allocationId, settled);
    return pending;
  }

  async function hasRoom(): Promise<boolean> {
    const { maxAllocations } = driver.limits;
    if (maxAllocations === undefined) return true;
    const running = (await driver.list()).filter((handle) => handle.running);
    return running.length < maxAllocations;
  }

  async function stop(handle: SidecarHandle): Promise<void> {
    await driver.stop(handle);
    if (handle.startedAt === undefined) return;
    const stoppedAt = new Date();
    onUsage({
      driverId: driver.id,
      tenantId: handle.tenantId,
      allocationId: handle.allocationId,
      generation: handle.generation,
      startedAt: handle.startedAt,
      stoppedAt,
      runtimeMs: stoppedAt.getTime() - handle.startedAt.getTime(),
    });
  }

  // A capped driver checks room and starts one allocation at a time, so concurrent ensures cannot all take the last slot.
  function admitted(operation: () => Promise<EnsureSidecarResult>): Promise<EnsureSidecarResult> {
    if (driver.limits.maxAllocations === undefined) return operation();
    const pending = after(admissions, operation);
    admissions = settle(pending);
    return pending;
  }

  async function startFresh(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    return admitted(() => startWithRoom(request));
  }

  async function startWithRoom(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    if (!(await hasRoom())) {
      return rejected("capacity_full", `Sidecar driver ${driver.id} already runs its ${String(driver.limits.maxAllocations)} allowed allocations`, true);
    }
    const { signal: _, ...launch } = request;
    let handle: SidecarHandle;
    try {
      handle = await driver.start(launch, envFor(launch));
    } catch (error) {
      const leftover = await driver.find(request.allocationId);
      if (leftover !== null && leftover.generation === request.generation) await stop(leftover);
      return rejected("spawn_failed", errorText(error), true);
    }
    fences.set(request.allocationId, { generation: request.generation, sidecarId: request.sidecarId, destroyed: false });
    return { kind: "accepted", externalRef: handle.externalRef };
  }

  async function ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const fence = fences.get(request.allocationId);
    const current = await driver.find(request.allocationId);
    const newest = Math.max(fence?.generation ?? 0, current?.generation ?? 0);
    if (newest > request.generation) {
      return rejected("stale_generation", `Generation ${String(request.generation)} is older than ${String(newest)}`, false);
    }
    // Replacement destroys the old identity at the new generation before
    // ensuring a fresh identity at that same generation: fence only the
    // exact identity that was destroyed.
    if (fence?.destroyed === true && fence.generation === request.generation && fence.sidecarId === request.sidecarId) {
      return rejected("generation_destroyed", `Generation ${String(request.generation)} was already destroyed`, false);
    }
    // Another identity's capacity at this generation conflicts even after it exited.
    if (current !== null && current.generation === request.generation && current.sidecarId !== request.sidecarId) {
      return rejected("sidecar_identity_conflict", `Generation ${String(request.generation)} already belongs to another sidecar identity`, false);
    }
    if (current?.running === true && current.generation === request.generation) {
      fences.set(request.allocationId, { generation: request.generation, sidecarId: request.sidecarId, destroyed: false });
      return { kind: "accepted", externalRef: current.externalRef };
    }
    if (current !== null) await stop(current);
    return startFresh(request);
  }

  async function destroy(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const fence = fences.get(request.allocationId);
    if (fence !== undefined && fence.generation > request.generation) return { kind: "destroyed" };
    const current = await driver.find(request.allocationId);
    // A newer generation, or the replacement identity that already owns this
    // one, is not this destroy's to stop.
    const supersedes = current !== null &&
      (current.generation > request.generation ||
        (current.generation === request.generation && current.sidecarId !== request.sidecarId));
    if (current !== null && !supersedes) await stop(current);
    fences.set(request.allocationId, { generation: request.generation, sidecarId: request.sidecarId, destroyed: true });
    return { kind: "destroyed" };
  }

  const provisioner: SidecarProvisioner = {
    id: driver.id,
    apiVersion: 1,
    bindingFingerprint: driver.fingerprint,
    capabilities: driver.capabilities,
    // Keep cleanup behind any late ensure for the same allocation, including
    // work the hub stopped awaiting after an operation timeout.
    ensure(request) {
      return exclusive(request.allocationId, () => ensure(request));
    },
    destroy(request) {
      return exclusive(request.allocationId, () => destroy(request));
    },
  };

  async function drain(): Promise<void> {
    draining = true;
    await Promise.all(queues.values());
  }

  function envFor(launch: SidecarLaunchSpec): SidecarEnv {
    return buildSidecarEnv(launch, credentialEncryptionKey);
  }

  return { provisioner, envFor, exclusive, hasRoom, drain };
}
