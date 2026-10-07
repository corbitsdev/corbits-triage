// Production copy of the provisioning logic in
// vendor/interchange/tests/admin-ui-e2e/harness/local-process-sidecar-provisioner.ts.
// The hub must not import from the vendor test harness: tests/ trees are not
// shipped and may change without notice. Unlike the harness, the caller always
// supplies the spawn so the child env is built from validated hub config.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
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
  /** 32 bytes as 64 hex characters; encrypts sidecar tokens at rest in manifests. */
  readonly manifestEncryptionKey: string;
  readonly stopTimeoutMs?: number;
};

type EncryptedToken = {
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
};

type StoredManifest = Omit<LocalSidecarManifest, "token"> & {
  readonly token: EncryptedToken;
};

/** What a hub restart needs to re-spawn an allocation identically. */
export type LocalSidecarManifest = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
  readonly tenantId: string;
  readonly anchorRunId: string;
  readonly hubWebSocketUrl: string;
  readonly dataDir: string;
  readonly token: string;
};

export type IsLocalSidecarLive = (manifest: LocalSidecarManifest) => Promise<boolean>;

export interface LocalProcessSidecarProvisioner {
  readonly provisioner: SidecarProvisioner;
  /** Respawns every manifest `isLive` accepts and removes the rest. */
  restore(isLive: IsLocalSidecarLive): Promise<void>;
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

function manifestsDir(dataRoot: string): string {
  return path.join(dataRoot, "manifests");
}

function manifestPath(dataRoot: string, allocationId: string): string {
  return path.join(manifestsDir(dataRoot), `${allocationId}.json`);
}

function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("Local sidecar manifest encryption key must be 32 bytes encoded as 64 hexadecimal characters");
  }
  return Buffer.from(hex, "hex");
}

function encryptToken(key: Buffer, token: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptToken(key: Buffer, token: EncryptedToken): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(token.iv, "base64"));
  decipher.setAuthTag(Buffer.from(token.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(token.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function writeManifest(
  dataRoot: string,
  key: Buffer,
  manifest: LocalSidecarManifest,
): Promise<void> {
  const target = manifestPath(dataRoot, manifest.allocationId);
  const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  const stored: StoredManifest = { ...manifest, token: encryptToken(key, manifest.token) };
  await fs.mkdir(manifestsDir(dataRoot), { recursive: true });
  try {
    await fs.writeFile(temp, JSON.stringify(stored), { mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Reads and decrypts every allocation manifest a previous hub process left behind. */
export async function readLocalSidecarManifests(
  dataRoot: string,
  manifestEncryptionKey: string,
): Promise<LocalSidecarManifest[]> {
  const key = parseKey(manifestEncryptionKey);
  let entries: string[];
  try {
    entries = await fs.readdir(manifestsDir(dataRoot));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const manifests: LocalSidecarManifest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(manifestsDir(dataRoot), entry);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as StoredManifest;
    manifests.push({ ...stored, token: decryptToken(key, stored.token) });
  }
  return manifests;
}

async function readStoredDataDir(dataRoot: string, allocationId: string): Promise<string | null> {
  try {
    const stored = JSON.parse(await fs.readFile(manifestPath(dataRoot, allocationId), "utf8")) as StoredManifest;
    return stored.dataDir;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function logAllocation(msg: string, manifest: LocalSidecarManifest): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    msg,
    allocationId: manifest.allocationId,
    generation: manifest.generation,
    sidecarId: manifest.sidecarId,
  }));
}

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
  manifestEncryptionKey,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
}: CreateLocalProcessSidecarProvisionerOpts): LocalProcessSidecarProvisioner {
  if (stopTimeoutMs <= 0) {
    throw new Error("Local sidecar stop timeout must be positive");
  }
  const key = parseKey(manifestEncryptionKey);

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

  async function stopProcess(
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
  }

  async function removeStored(allocationId: string, dataDir: string): Promise<void> {
    await fs.rm(manifestPath(dataRoot, allocationId), { force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  async function stopAndRemove(
    allocationId: string,
    state: Extract<AllocationState, { kind: "live" }>,
  ): Promise<void> {
    await stopProcess(state);
    await removeStored(allocationId, state.dataDir);
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
      await stopAndRemove(request.allocationId, existing);
    }

    await fs.mkdir(dataRoot, { recursive: true });
    const dataDir = await fs.mkdtemp(
      path.join(dataRoot, `${request.allocationId}-`),
    );
    let live: Extract<AllocationState, { kind: "live" }> | undefined;
    try {
      request.signal?.throwIfAborted();
      const handle = spawnSidecar({ request, dataDir });
      const managed: ManagedProcess = { handle, exited: false };
      void trackExit(managed);
      live = {
        kind: "live",
        generation: request.generation,
        sidecarId: request.sidecarId,
        dataDir,
        process: managed,
      };
      allocations.set(request.allocationId, live);
      await writeManifest(dataRoot, key, {
        allocationId: request.allocationId,
        generation: request.generation,
        sidecarId: request.sidecarId,
        tenantId: request.tenantId,
        anchorRunId: request.anchorRunId,
        hubWebSocketUrl: request.hubWebSocketUrl,
        dataDir,
        token: request.token,
      });
      return { kind: "accepted" as const, externalRef: String(handle.pid) };
    } catch (error) {
      if (live === undefined) {
        await fs.rm(dataDir, { recursive: true, force: true });
      } else {
        allocations.delete(request.allocationId);
        await stopAndRemove(request.allocationId, live);
      }
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
      await stopAndRemove(request.allocationId, existing);
    }
    if (existing === undefined) {
      // A previous hub process may have left this allocation's state on disk.
      const dataDir = await readStoredDataDir(dataRoot, request.allocationId);
      if (dataDir !== null) await removeStored(request.allocationId, dataDir);
    }
    allocations.set(request.allocationId, {
      kind: "destroyed",
      generation: request.generation,
      sidecarId: request.sidecarId,
    });
    return { kind: "destroyed" as const };
  }

  // Ensure or destroy may reach an allocation before restore does; their
  // outcome wins.
  async function restoreAllocation(
    { manifest, isLive }: { readonly allocationId: string; readonly manifest: LocalSidecarManifest; readonly isLive: IsLocalSidecarLive },
  ): Promise<void> {
    if (allocations.has(manifest.allocationId)) return;
    if (!(await isLive(manifest))) {
      await removeStored(manifest.allocationId, manifest.dataDir);
      logAllocation("local_sidecar_removed", manifest);
      return;
    }
    const handle = spawnSidecar({ request: manifest, dataDir: manifest.dataDir });
    const managed: ManagedProcess = { handle, exited: false };
    void trackExit(managed);
    allocations.set(manifest.allocationId, {
      kind: "live",
      generation: manifest.generation,
      sidecarId: manifest.sidecarId,
      dataDir: manifest.dataDir,
      process: managed,
    });
    logAllocation("local_sidecar_respawned", manifest);
  }

  async function restore(isLive: IsLocalSidecarLive): Promise<void> {
    const manifests = await readLocalSidecarManifests(dataRoot, manifestEncryptionKey);
    for (const manifest of manifests) {
      await serialize({ allocationId: manifest.allocationId, manifest, isLive }, restoreAllocation);
    }
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

  // Data dirs and manifests survive shutdown so the next hub boot can respawn.
  async function stopAll(): Promise<void> {
    await Promise.all(operations.values());
    const failures: unknown[] = [];
    for (const state of allocations.values()) {
      if (state.kind !== "live") continue;
      try {
        await stopProcess(state);
      } catch (error) {
        failures.push(error);
      }
    }
    allocations.clear();
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to stop every local sidecar process",
      );
    }
  }

  return {
    provisioner,
    restore,
    shutdown() {
      shutdownPromise ??= stopAll();
      return shutdownPromise;
    },
  };
}
