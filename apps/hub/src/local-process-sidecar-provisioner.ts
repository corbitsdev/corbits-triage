// Production copy of the provisioning logic in
// vendor/interchange/tests/admin-ui-e2e/harness/local-process-sidecar-provisioner.ts.
// The hub must not import from the vendor test harness: tests/ trees are not
// shipped and may change without notice. Unlike the harness, the caller always
// supplies the spawn so the child env is built from validated hub config.
import fs from "node:fs/promises";
import path from "node:path";

// Minimal structural mirror of the stock @intx/hub-sessions sidecar
// allocation contract (see the `sidecar-allocation/contracts` module of the
// npm 0.4.0 package). Defined locally so this prod file depends on neither
// the vendor test harness nor a new package dependency; the shapes stay
// assignable to the stock contract by construction.
export interface EnsureSidecarRequest {
  readonly signal?: AbortSignal;
  readonly allocationId: string;
  readonly generation: number;
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly sidecarId: string;
  readonly token: string;
  readonly hubWebSocketUrl: string;
}

export interface DestroySidecarRequest {
  readonly signal?: AbortSignal;
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly externalRef?: string;
}

export type EnsureSidecarResult =
  | { readonly kind: "accepted"; readonly externalRef?: string }
  | { readonly kind: "rejected"; readonly code: string; readonly message: string; readonly retryable: boolean };

export type DestroySidecarResult =
  | { readonly kind: "destroyed" }
  | { readonly kind: "rejected"; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface SidecarProvisioner {
  readonly id: string;
  readonly apiVersion: 1;
  readonly bindingFingerprint: string;
  readonly capabilities: readonly never[];
  ensure(request: EnsureSidecarRequest): Promise<EnsureSidecarResult>;
  destroy(request: DestroySidecarRequest): Promise<DestroySidecarResult>;
}

const DEFAULT_STOP_TIMEOUT_MS = 1_000;

export interface LocalSidecarProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnLocalSidecar = (args: {
  readonly request: EnsureSidecarRequest;
  readonly dataDir: string;
}) => LocalSidecarProcess;

export type CreateLocalProcessSidecarProvisionerOpts = {
  readonly dataRoot: string;
  readonly spawnSidecar: SpawnLocalSidecar;
  readonly stopTimeoutMs?: number;
};

export interface LocalProcessSidecarProvisioner {
  readonly provisioner: SidecarProvisioner;
  shutdown(): Promise<void>;
}

type ManagedProcess = {
  readonly handle: LocalSidecarProcess;
  exited: boolean;
};

type AllocationState =
  | {
      readonly kind: "live";
      readonly generation: number;
      readonly sidecarId: string;
      readonly dataDir: string;
      readonly process: ManagedProcess;
    }
  | {
      readonly kind: "destroyed";
      readonly generation: number;
      readonly sidecarId: string;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(managed: ManagedProcess): Promise<true> {
  await managed.handle.exited;
  return true;
}

async function exitedWithin(
  managed: ManagedProcess,
  timeoutMs: number,
): Promise<boolean> {
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

async function trackExit(managed: ManagedProcess): Promise<void> {
  try {
    await managed.handle.exited;
  } finally {
    managed.exited = true;
  }
}

async function settle(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller observes the failure; the per-allocation queue only needs ordering.
  }
}

export function createLocalProcessSidecarProvisioner({
  dataRoot,
  spawnSidecar,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
}: CreateLocalProcessSidecarProvisionerOpts): LocalProcessSidecarProvisioner {
  if (stopTimeoutMs <= 0) {
    throw new Error("Local sidecar stop timeout must be positive");
  }

  const allocations = new Map<string, AllocationState>();
  const operations = new Map<string, Promise<void>>();
  let shutdownPromise: Promise<void> | null = null;

  async function runAfter<R, T>(
    previous: Promise<void> | undefined,
    request: R,
    run: (request: R) => Promise<T>,
  ): Promise<T> {
    await previous;
    return run(request);
  }

  async function releaseWhenSettled(allocationId: string, settled: Promise<void>): Promise<void> {
    await settled;
    if (operations.get(allocationId) === settled) operations.delete(allocationId);
  }

  async function serialize<R extends { readonly allocationId: string }, T>(
    request: R,
    run: (request: R) => Promise<T>,
  ): Promise<T> {
    if (shutdownPromise !== null) {
      throw new Error("Local sidecar provisioner is shutting down");
    }
    const pending = runAfter(operations.get(request.allocationId), request, run);
    const settled = settle(pending);
    operations.set(request.allocationId, settled);
    void releaseWhenSettled(request.allocationId, settled);
    return pending;
  }

  async function stopAndRemove(
    state: Extract<AllocationState, { kind: "live" }>,
  ): Promise<void> {
    if (!state.process.exited) {
      try {
        state.process.handle.kill("SIGTERM");
      } catch (error) {
        if (!state.process.exited) throw error;
      }
      if (!(await exitedWithin(state.process, stopTimeoutMs))) {
        state.process.handle.kill("SIGKILL");
        if (!(await exitedWithin(state.process, stopTimeoutMs))) {
          throw new Error(
            `Local sidecar process ${String(state.process.handle.pid)} did not exit`,
          );
        }
      }
    }
    await fs.rm(state.dataDir, { recursive: true, force: true });
  }

  async function ensureAllocation(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const existing = allocations.get(request.allocationId);
    if (existing !== undefined && existing.generation > request.generation) {
      return {
        kind: "rejected" as const,
        code: "stale_generation",
        message: `Generation ${String(request.generation)} is older than ${String(existing.generation)}`,
        retryable: false,
      };
    }
    // Replacement destroys the old identity at the new generation before
    // ensuring a fresh identity at that same generation. Fence only the exact
    // identity that was destroyed.
    if (
      existing?.kind === "destroyed" &&
      existing.generation === request.generation &&
      existing.sidecarId === request.sidecarId
    ) {
      return {
        kind: "rejected" as const,
        code: "generation_destroyed",
        message: `Generation ${String(request.generation)} was already destroyed`,
        retryable: false,
      };
    }
    if (
      existing?.kind === "live" &&
      existing.generation === request.generation &&
      existing.sidecarId !== request.sidecarId
    ) {
      return {
        kind: "rejected" as const,
        code: "sidecar_identity_conflict",
        message: `Generation ${String(request.generation)} already belongs to another sidecar identity`,
        retryable: false,
      };
    }
    if (
      existing?.kind === "live" &&
      existing.generation === request.generation &&
      !existing.process.exited
    ) {
      return {
        kind: "accepted" as const,
        externalRef: String(existing.process.handle.pid),
      };
    }
    if (existing?.kind === "live") {
      await stopAndRemove(existing);
    }

    await fs.mkdir(dataRoot, { recursive: true });
    const dataDir = await fs.mkdtemp(
      path.join(dataRoot, `${request.allocationId}-`),
    );
    try {
      request.signal?.throwIfAborted();
      const handle = spawnSidecar({ request, dataDir });
      const managed: ManagedProcess = { handle, exited: false };
      void trackExit(managed);
      allocations.set(request.allocationId, {
        kind: "live",
        generation: request.generation,
        sidecarId: request.sidecarId,
        dataDir,
        process: managed,
      });
      return { kind: "accepted" as const, externalRef: String(handle.pid) };
    } catch (error) {
      await fs.rm(dataDir, { recursive: true, force: true });
      return {
        kind: "rejected" as const,
        code: "spawn_failed",
        message: errorMessage(error),
        retryable: true,
      };
    }
  }

  async function destroyAllocation(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const existing = allocations.get(request.allocationId);
    if (existing !== undefined && existing.generation > request.generation) {
      return { kind: "destroyed" as const };
    }
    // A delayed destroy for the superseded identity must not terminate the
    // replacement that already owns this generation.
    if (existing !== undefined && existing.sidecarId !== request.sidecarId) {
      return { kind: "destroyed" as const };
    }
    if (existing?.kind === "live") {
      await stopAndRemove(existing);
    }
    allocations.set(request.allocationId, {
      kind: "destroyed",
      generation: request.generation,
      sidecarId: request.sidecarId,
    });
    return { kind: "destroyed" as const };
  }

  const provisioner: SidecarProvisioner = {
    id: "local-process",
    apiVersion: 1,
    bindingFingerprint: "local-process:v1",
    capabilities: [],
    // Keep cleanup behind any late ensure for the same allocation, including
    // work the Hub stopped awaiting after an operation timeout.
    ensure(request) {
      return serialize(request, ensureAllocation);
    },
    destroy(request) {
      return serialize(request, destroyAllocation);
    },
  };

  async function stopAll(): Promise<void> {
    await Promise.all(operations.values());
    const failures: unknown[] = [];
    for (const state of allocations.values()) {
      if (state.kind !== "live") continue;
      try {
        await stopAndRemove(state);
      } catch (error) {
        failures.push(error);
      }
    }
    allocations.clear();
    await fs.rm(dataRoot, { recursive: true, force: true });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to stop every local sidecar process",
      );
    }
  }

  return {
    provisioner,
    shutdown() {
      shutdownPromise ??= stopAll();
      return shutdownPromise;
    },
  };
}
