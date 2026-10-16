// Production copy of the provisioning logic in
// vendor/interchange/tests/admin-ui-e2e/harness/local-process-sidecar-provisioner.ts.
// The hub must not import from the vendor test harness: tests/ trees are not
// shipped and may change without notice.
import fs from "node:fs/promises";
import path from "node:path";
import type { AdapterManifest } from "@intx/types";
import type { ChildProcessEnv } from "../env.js";
import type { DriverProvisioner, SidecarDriver, SidecarHandle } from "./driver-provisioner.js";
import type { LocalSidecarManifest, LocalSidecarManifestStore } from "./manifest-store.js";
import { buildSidecarEnv, type SidecarEnv, type SidecarLaunchSpec } from "./sidecar-env.js";

const DEFAULT_STOP_TIMEOUT_MS = 25_000;

export interface LocalSidecarProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnLocalSidecar = (env: SidecarEnv & { readonly SIDECAR_DATA_DIR: string }) => LocalSidecarProcess;

export type CreateLocalProcessDriverOpts = {
  readonly dataRoot: string;
  readonly spawnSidecar: SpawnLocalSidecar;
  readonly manifests: LocalSidecarManifestStore;
  /** Restores records written before manifests carried `adapterManifest`. */
  readonly adapterManifest: AdapterManifest;
  readonly stopTimeoutMs?: number;
  readonly log: (entry: Record<string, unknown>) => void;
};

type IsLocalSidecarLive = (manifest: LocalSidecarManifest) => Promise<boolean>;

export interface LocalProcessDriver extends SidecarDriver {
  /** Respawns the sidecars a previous hub process left live; removes the rest. */
  restore(seam: DriverProvisioner, isLive: IsLocalSidecarLive, credentialEncryptionKey: string): Promise<void>;
  /** Stops every process; data dirs and manifests stay so the next boot can respawn. */
  stopAll(): Promise<void>;
}

type Running = {
  readonly manifest: LocalSidecarManifest;
  readonly process: LocalSidecarProcess;
  exited: boolean;
};

export function createSpawnLocalSidecar(interchangeDir: string, processEnv: ChildProcessEnv): SpawnLocalSidecar {
  return function spawnSidecar(env) {
    const child = Bun.spawn(["bun", "--conditions=intx-src", "apps/sidecar/src/index.ts"], {
      cwd: interchangeDir,
      env: { ...processEnv, ...env },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    return {
      pid: child.pid,
      exited: child.exited,
      kill(signal) {
        child.kill(signal);
      },
    };
  };
}

async function waitForExit(running: Running): Promise<true> {
  await running.process.exited;
  return true;
}

async function exitedWithin(running: Running, timeoutMs: number): Promise<boolean> {
  if (running.exited) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>(function scheduleTimeout(resolve) {
    timer = setTimeout(resolve, timeoutMs, false);
  });
  try {
    return await Promise.race([waitForExit(running), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function trackExit(running: Running): Promise<void> {
  try {
    await running.process.exited;
  } finally {
    running.exited = true;
  }
}

function handleOf(manifest: Omit<LocalSidecarManifest, "token">, externalRef: string, running: boolean): SidecarHandle {
  return { allocationId: manifest.allocationId, generation: manifest.generation, sidecarId: manifest.sidecarId, externalRef, running };
}

/** Child processes of the hub: posix tools and the network, no isolation from the hub or each other. */
export function createLocalProcessDriver({
  dataRoot,
  spawnSidecar,
  manifests,
  adapterManifest,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  log,
}: CreateLocalProcessDriverOpts): LocalProcessDriver {
  if (stopTimeoutMs <= 0) throw new Error("Local sidecar stop timeout must be positive");
  const processes = new Map<string, Running>();

  function launch(manifest: LocalSidecarManifest, env: SidecarEnv): Running {
    const running: Running = { manifest, process: spawnSidecar({ ...env, SIDECAR_DATA_DIR: manifest.dataDir }), exited: false };
    void trackExit(running);
    processes.set(manifest.allocationId, running);
    return running;
  }

  async function stopProcess(running: Running): Promise<void> {
    if (running.exited) return;
    try {
      running.process.kill("SIGTERM");
    } catch (error) {
      if (!running.exited) throw error;
    }
    if (await exitedWithin(running, stopTimeoutMs)) return;
    running.process.kill("SIGKILL");
    if (!(await exitedWithin(running, stopTimeoutMs))) {
      throw new Error(`Local sidecar process ${String(running.process.pid)} did not exit`);
    }
  }

  async function removeStored(allocationId: string, dataDir: string): Promise<void> {
    await manifests.remove(allocationId);
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  async function start(spec: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle> {
    await fs.mkdir(dataRoot, { recursive: true });
    const dataDir = await fs.mkdtemp(path.join(dataRoot, `${spec.allocationId}-`));
    const { tenantId, anchorRunId, allocationId, generation, sidecarId, hubWebSocketUrl, token } = spec;
    const manifest: LocalSidecarManifest = {
      allocationId, generation, sidecarId, tenantId, anchorRunId, hubWebSocketUrl, token, dataDir,
      ...(spec.adapterManifest !== undefined && { adapterManifest: spec.adapterManifest }),
    };
    let running: Running | undefined;
    try {
      running = launch(manifest, env);
      await manifests.write(manifest);
      return handleOf(manifest, String(running.process.pid), true);
    } catch (error) {
      if (running !== undefined) {
        processes.delete(allocationId);
        await stopProcess(running);
      }
      await removeStored(allocationId, dataDir);
      throw error;
    }
  }

  async function stop(handle: SidecarHandle): Promise<void> {
    const running = processes.get(handle.allocationId);
    if (running !== undefined) {
      await stopProcess(running);
      processes.delete(handle.allocationId);
      await removeStored(handle.allocationId, running.manifest.dataDir);
      return;
    }
    // A previous hub process may have left this allocation's state on disk.
    const stored = await manifests.read(handle.allocationId);
    if (stored !== null) await removeStored(handle.allocationId, stored.dataDir);
  }

  async function find(allocationId: string): Promise<SidecarHandle | null> {
    const running = processes.get(allocationId);
    if (running !== undefined) return handleOf(running.manifest, String(running.process.pid), !running.exited);
    const stored = await manifests.read(allocationId);
    return stored === null ? null : handleOf(stored, "", false);
  }

  async function restore(seam: DriverProvisioner, isLive: IsLocalSidecarLive, credentialEncryptionKey: string): Promise<void> {
    for (const manifest of await manifests.readAll()) {
      await seam.exclusive(manifest.allocationId, async function restoreAllocation() {
        // Ensure or destroy may reach an allocation before restore does; their outcome wins.
        if (processes.has(manifest.allocationId) || (await manifests.read(manifest.allocationId)) === null) return;
        if (!(await isLive(manifest))) {
          await removeStored(manifest.allocationId, manifest.dataDir);
          log({ level: "info", msg: "local_sidecar_removed", allocationId: manifest.allocationId, generation: manifest.generation, sidecarId: manifest.sidecarId });
          return;
        }
        launch(manifest, buildSidecarEnv({ ...manifest, adapterManifest: manifest.adapterManifest ?? adapterManifest }, credentialEncryptionKey));
        log({ level: "info", msg: "local_sidecar_respawned", allocationId: manifest.allocationId, generation: manifest.generation, sidecarId: manifest.sidecarId });
      });
    }
  }

  async function stopAll(): Promise<void> {
    const results = await Promise.allSettled([...processes.values()].map(stopProcess));
    processes.clear();
    const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "Failed to stop every local sidecar process");
  }

  return {
    id: "local-process",
    fingerprint: "local-process:v1",
    capabilities: [
      { capability: "runtime:posix", state: "available" },
      { capability: "network:outbound", state: "available" },
      // Every sidecar runs as the hub's OS user over the hub's data root.
      { capability: "isolation:*", state: "blocked" },
    ],
    start,
    stop,
    find,
    restore,
    stopAll,
  };
}
