import { type } from "arktype";
import type { AdapterManifest } from "@intx/types";
import type { SidecarDriver, SidecarHandle } from "./driver-provisioner.js";
import type { SidecarEnv, SidecarLaunchSpec } from "./sidecar-env.js";

const ALLOCATION_LABEL = "intx.allocation";
const GENERATION_LABEL = "intx.generation";
const SIDECAR_LABEL = "intx.sidecar";
const DATA_DIR = "/var/lib/intx-sidecar";
const STOP_TIMEOUT_SECONDS = 25;
/** WORKDIR of the root Dockerfile's `sidecar` stage, one level above vendor/interchange. */
const IMAGE_ROOT = "/app";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const Container = type({
  Id: "string",
  State: "string",
  Labels: { [ALLOCATION_LABEL]: "string", [GENERATION_LABEL]: "string.integer.parse", [SIDECAR_LABEL]: "string" },
});

export type CreateDockerDriverOpts = {
  /** Path of the Docker Engine socket. */
  readonly socketPath: string;
  readonly image: string;
  /** The repository root on the hub; adapter modules under it are found at the same path under the image's root. */
  readonly hostRoot: string;
  /** The hub's adapter manifest, checked at boot so a module the image cannot load fails here, not at the first ensure. */
  readonly adapterManifest: AdapterManifest;
};

export class DockerEngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** One container per allocation from the sidecar image: its own filesystem and processes, sharing only the kernel. */
export function createDockerDriver({ socketPath, image, hostRoot, adapterManifest }: CreateDockerDriverOpts): SidecarDriver {
  const hostPrefix = new URL(`file://${hostRoot.replace(/\/+$/, "")}/`).href;
  const imagePrefix = `file://${IMAGE_ROOT}/`;

  function inImage(manifest: AdapterManifest): AdapterManifest {
    return manifest.map(function relocate(entry) {
      if (!entry.specifier.startsWith("file:")) return entry;
      if (!entry.specifier.startsWith(hostPrefix)) {
        throw new Error(`Adapter module ${entry.specifier} is outside ${hostRoot}, so the sidecar image does not have it`);
      }
      return { ...entry, specifier: imagePrefix + entry.specifier.slice(hostPrefix.length) };
    });
  }
  inImage(adapterManifest);

  async function engine(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://docker${path}`, {
      method,
      unix: socketPath,
      ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new DockerEngineError(response.status, `Docker ${method} ${path.split("?")[0]} failed (${String(response.status)}): ${text}`);
    return text === "" ? null : JSON.parse(text);
  }

  // A container cannot reach the hub's loopback; Docker maps host.docker.internal to the host.
  function hubUrlFromContainer(url: string): string {
    const parsed = new URL(url);
    if (LOOPBACK.has(parsed.hostname)) parsed.hostname = "host.docker.internal";
    return parsed.href;
  }

  function containerEnv(env: SidecarEnv): string[] {
    const manifest = JSON.parse(env.SIDECAR_ADAPTER_MANIFEST) as AdapterManifest;
    const vars = {
      ...env,
      HUB_WS_URL: hubUrlFromContainer(env.HUB_WS_URL),
      SIDECAR_ADAPTER_MANIFEST: JSON.stringify(inImage(manifest)),
      SIDECAR_DATA_DIR: DATA_DIR,
    };
    return Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  }

  function handleOf(container: typeof Container.infer): SidecarHandle {
    return {
      allocationId: container.Labels[ALLOCATION_LABEL],
      generation: container.Labels[GENERATION_LABEL],
      sidecarId: container.Labels[SIDECAR_LABEL],
      externalRef: container.Id,
      running: container.State === "running",
    };
  }

  async function remove(id: string): Promise<void> {
    try {
      await engine("POST", `/containers/${id}/stop?t=${String(STOP_TIMEOUT_SECONDS)}`);
    } catch (error) {
      // 304: already stopped. 404: already removed.
      if (!(error instanceof DockerEngineError) || (error.status !== 304 && error.status !== 404)) throw error;
    }
    try {
      await engine("DELETE", `/containers/${id}?force=true&v=true`);
    } catch (error) {
      if (!(error instanceof DockerEngineError) || error.status !== 404) throw error;
    }
  }

  async function start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle> {
    const created = type({ Id: "string" }).assert(await engine("POST", `/containers/create?name=intx-${launch.allocationId}-${String(launch.generation)}`, {
      Image: image,
      Env: containerEnv(env),
      Labels: {
        [ALLOCATION_LABEL]: launch.allocationId,
        [GENERATION_LABEL]: String(launch.generation),
        [SIDECAR_LABEL]: launch.sidecarId,
      },
      HostConfig: {
        ExtraHosts: ["host.docker.internal:host-gateway"],
        // As PID 1 the sidecar would ignore SIGTERM; an init process lets a stop end it at once.
        Init: true,
        RestartPolicy: { Name: "unless-stopped" },
      },
    }));
    try {
      await engine("POST", `/containers/${created.Id}/start`);
    } catch (error) {
      await remove(created.Id);
      throw error;
    }
    return { allocationId: launch.allocationId, generation: launch.generation, sidecarId: launch.sidecarId, externalRef: created.Id, running: true };
  }

  async function list(allocationId: string): Promise<SidecarHandle[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${ALLOCATION_LABEL}=${allocationId}`] }));
    const containers = Container.array().assert(await engine("GET", `/containers/json?all=true&filters=${filters}`)).map(handleOf);
    return containers.sort((left, right) => right.generation - left.generation);
  }

  async function find(allocationId: string): Promise<SidecarHandle | null> {
    return (await list(allocationId))[0] ?? null;
  }

  // Also removes containers an interrupted older generation left behind.
  async function stop(handle: SidecarHandle): Promise<void> {
    for (const container of await list(handle.allocationId)) {
      if (container.generation <= handle.generation) await remove(container.externalRef);
    }
  }

  return {
    id: "docker",
    fingerprint: `docker:v1:${image}`,
    capabilities: [
      { capability: "runtime:posix", state: "available" },
      { capability: "network:outbound", state: "available" },
      { capability: "isolation:workload", state: "available" },
      { capability: "isolation:microvm", state: "blocked" },
    ],
    start,
    stop,
    find,
  };
}
