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
  readonly externalRef: string;
  readonly running: boolean;
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
  /** Starts the sidecar with exactly `env`. A throw must leave nothing behind that `find` cannot see. */
  start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle>;
  /** Idempotent: capacity already gone is not an error. */
  stop(handle: SidecarHandle): Promise<void>;
  /** The allocation's newest capacity, running or not, or null when it has none. */
  find(allocationId: string): Promise<SidecarHandle | null>;
}

export type DriverProvisioner = {
  readonly provisioner: SidecarProvisioner;
  /** The environment a sidecar of this driver starts with. */
  envFor(launch: SidecarLaunchSpec): SidecarEnv;
  /** Runs `operation` in the allocation's queue, ordered with its ensure and destroy calls. */
  exclusive<T>(allocationId: string, operation: () => Promise<T>): Promise<T>;
  /** Refuses new operations and waits for the ones in flight. */
  drain(): Promise<void>;
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
export function createDriverProvisioner(driver: SidecarDriver, credentialEncryptionKey: string): DriverProvisioner {
  const fences = new Map<string, Fence>();
  const queues = new Map<string, Promise<void>>();
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

  async function startFresh(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const { signal: _, ...launch } = request;
    let handle: SidecarHandle;
    try {
      handle = await driver.start(launch, envFor(launch));
    } catch (error) {
      const leftover = await driver.find(request.allocationId);
      if (leftover !== null && leftover.generation === request.generation) await driver.stop(leftover);
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
    if (current !== null) await driver.stop(current);
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
    if (current !== null && !supersedes) await driver.stop(current);
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

  return { provisioner, envFor, exclusive, drain };
}
