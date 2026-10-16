import { type } from "arktype";
import type { AdapterManifest } from "@intx/types";
import type { SidecarDriver, SidecarDriverLimits, SidecarEnv, SidecarHandle, SidecarLaunchSpec } from "@corbits/provisioner";
import { RELAY_HUB_PORT, RELAY_PROXY_PORT } from "./relay.js";

const ALLOCATION_LABEL = "intx.allocation";
const GENERATION_LABEL = "intx.generation";
const SIDECAR_LABEL = "intx.sidecar";
const TENANT_LABEL = "intx.tenant";
const RELAY_LABEL = "intx.relay";
const RELAY_TARGET_LABEL = "intx.relay.target";
const NETWORK = "intx-sidecars";
const RELAY_NAME = "intx-sidecar-relay";
const HUB_ALIAS = "intx-hub";
const EGRESS_ALIAS = "intx-egress";
/** A volume, so the root filesystem can stay read-only; it holds the secrets file and the sidecar's data. */
const STATE_DIR = "/var/lib/intx-sidecar";
const SECRETS_FILE = "secrets.env";
const PIDS_LIMIT = 1024;
const STOP_TIMEOUT_SECONDS = 25;
/** WORKDIR of the root Dockerfile's `sidecar` stage, one level above vendor/interchange. */
const IMAGE_ROOT = "/app";
const SECRET_NAMES = ["SIDECAR_TOKEN", "SIDECAR_CREDENTIAL_ENCRYPTION_KEY"] as const;

const HARDENED = {
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges"],
  ReadonlyRootfs: true,
  Tmpfs: { "/tmp": "" },
  PidsLimit: PIDS_LIMIT,
  // As PID 1 a process would ignore SIGTERM; an init process lets a stop end it at once.
  Init: true,
  RestartPolicy: { Name: "unless-stopped" },
};

const Container = type({
  Id: "string",
  State: "string",
  Created: "number",
  Labels: { [ALLOCATION_LABEL]: "string", [GENERATION_LABEL]: "string.integer.parse", [SIDECAR_LABEL]: "string", [TENANT_LABEL]: "string" },
});

/** The size class every container gets. Unset fields are unbounded. */
export type DockerSidecarSize = {
  readonly memoryBytes?: number;
  readonly cpus?: number;
};

export type CreateDockerDriverOpts = {
  /** Path of the Docker Engine socket. */
  readonly socketPath: string;
  readonly image: string;
  /** The port the hub listens on, on the Docker host. Sidecars reach it only through the relay. */
  readonly hubPort: number;
  /** The repository root on the hub; adapter modules under it are found at the same path under the image's root. */
  readonly hostRoot: string;
  /** The hub's adapter manifest, checked at boot so a module the image cannot load fails here, not at the first ensure. */
  readonly adapterManifest: AdapterManifest;
  readonly size?: DockerSidecarSize;
  readonly limits?: SidecarDriverLimits;
};

const RelayContainer = type({ Config: { Labels: { "[string]": "string" } } });

class DockerEngineError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * One container per allocation from the sidecar image: its own filesystem and processes, sharing only the kernel.
 * Containers sit on an internal network whose only way out is one relay container: to the hub, and HTTPS to public addresses.
 */
export function createDockerDriver({ socketPath, image, hubPort, hostRoot, adapterManifest, size = {}, limits = {} }: CreateDockerDriverOpts): SidecarDriver {
  const relayTarget = `host.docker.internal:${String(hubPort)}`;
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
      ...(body instanceof Uint8Array && { headers: { "content-type": "application/x-tar" }, body }),
      ...(body !== undefined && !(body instanceof Uint8Array) && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new DockerEngineError(response.status, `Docker ${method} ${path.split("?")[0]} failed (${String(response.status)}): ${text}`);
    return text === "" ? null : JSON.parse(text);
  }

  async function ignoring(statuses: readonly number[], operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      if (!(error instanceof DockerEngineError) || !statuses.includes(error.status)) throw error;
    }
  }

  // The sidecar dials the relay, which forwards to the hub's own listener whatever URL the hub advertises.
  function hubUrlFromContainer(url: string): string {
    const parsed = new URL(url);
    return `ws://${HUB_ALIAS}:${String(RELAY_HUB_PORT)}${parsed.pathname}${parsed.search}`;
  }

  // Secrets go in a file, not the container config, so `docker inspect` does not show them.
  function containerEnv(env: SidecarEnv): string[] {
    const { SIDECAR_TOKEN: _token, SIDECAR_CREDENTIAL_ENCRYPTION_KEY: _key, ...rest } = env;
    const proxy = `http://${EGRESS_ALIAS}:${String(RELAY_PROXY_PORT)}`;
    const vars = {
      ...rest,
      HUB_WS_URL: hubUrlFromContainer(env.HUB_WS_URL),
      SIDECAR_ADAPTER_MANIFEST: JSON.stringify(inImage(JSON.parse(env.SIDECAR_ADAPTER_MANIFEST) as AdapterManifest)),
      SIDECAR_DATA_DIR: `${STATE_DIR}/data`,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      NO_PROXY: HUB_ALIAS,
      no_proxy: HUB_ALIAS,
    };
    return Object.entries(vars).map(([name, value]) => `${name}=${value}`);
  }

  function secretsArchive(env: SidecarEnv): Promise<Uint8Array> {
    const lines = SECRET_NAMES.map(function line(name) {
      if (/[\s"'\\]/.test(env[name])) throw new Error(`${name} cannot be written to an env file`);
      return `${name}=${env[name]}\n`;
    });
    return new Bun.Archive({ [SECRETS_FILE]: lines.join("") }).bytes();
  }

  // On the default bridge to reach the host and the internet, and on the internal network under both aliases.
  function createRelay(): Promise<unknown> {
    return engine("POST", `/containers/create?name=${RELAY_NAME}`, {
      Image: image,
      Cmd: ["bun", `${IMAGE_ROOT}/packages/provisioner-docker/src/relay.ts`],
      Env: [`RELAY_HUB_TARGET=${relayTarget}`],
      User: "bun",
      Labels: { [RELAY_LABEL]: "true", [RELAY_TARGET_LABEL]: relayTarget },
      HostConfig: { ...HARDENED, NetworkMode: "bridge", ExtraHosts: ["host.docker.internal:host-gateway"] },
      NetworkingConfig: { EndpointsConfig: { bridge: {}, [NETWORK]: { Aliases: [HUB_ALIAS, EGRESS_ALIAS] } } },
    });
  }

  async function relayLabels(): Promise<Record<string, string> | null> {
    try {
      return RelayContainer.assert(await engine("GET", `/containers/${RELAY_NAME}/json`)).Config.Labels;
    } catch (error) {
      if (error instanceof DockerEngineError && error.status === 404) return null;
      throw error;
    }
  }

  // Idempotent, so every start can call it: a relay left by a hub on another port is replaced.
  async function ensureRelay(): Promise<void> {
    await ignoring([409], engine("POST", "/networks/create", { Name: NETWORK, Internal: true, Labels: { [RELAY_LABEL]: "true" } }));
    const labels = await relayLabels();
    if (labels?.[RELAY_TARGET_LABEL] !== relayTarget) {
      if (labels !== null) await engine("DELETE", `/containers/${RELAY_NAME}?force=true`);
      await ignoring([409], createRelay());
    }
    await ignoring([304], engine("POST", `/containers/${RELAY_NAME}/start`));
  }

  function handleOf(container: typeof Container.infer): SidecarHandle {
    return {
      allocationId: container.Labels[ALLOCATION_LABEL],
      generation: container.Labels[GENERATION_LABEL],
      sidecarId: container.Labels[SIDECAR_LABEL],
      tenantId: container.Labels[TENANT_LABEL],
      externalRef: container.Id,
      running: container.State === "running",
      startedAt: new Date(container.Created * 1000),
    };
  }

  async function remove(id: string): Promise<void> {
    // 304: already stopped. 404: already removed.
    await ignoring([304, 404], engine("POST", `/containers/${id}/stop?t=${String(STOP_TIMEOUT_SECONDS)}`));
    await ignoring([404], engine("DELETE", `/containers/${id}?force=true&v=true`));
  }

  async function start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle> {
    await ensureRelay();
    const created = type({ Id: "string" }).assert(await engine("POST", `/containers/create?name=intx-${launch.allocationId}-${String(launch.generation)}`, {
      Image: image,
      Cmd: ["bun", `--env-file=${STATE_DIR}/${SECRETS_FILE}`, "--conditions=intx-src", "apps/sidecar/src/index.ts"],
      Env: containerEnv(env),
      User: "bun",
      Labels: {
        [ALLOCATION_LABEL]: launch.allocationId,
        [GENERATION_LABEL]: String(launch.generation),
        [SIDECAR_LABEL]: launch.sidecarId,
        [TENANT_LABEL]: launch.tenantId,
      },
      HostConfig: {
        ...HARDENED,
        NetworkMode: NETWORK,
        Mounts: [{ Type: "volume", Target: STATE_DIR }],
        ...(size.memoryBytes !== undefined && { Memory: size.memoryBytes }),
        ...(size.cpus !== undefined && { NanoCpus: Math.round(size.cpus * 1e9) }),
      },
    }));
    try {
      await engine("PUT", `/containers/${created.Id}/archive?path=${encodeURIComponent(STATE_DIR)}`, await secretsArchive(env));
      await engine("POST", `/containers/${created.Id}/start`);
    } catch (error) {
      await remove(created.Id);
      throw error;
    }
    const { allocationId, generation, sidecarId, tenantId } = launch;
    return { allocationId, generation, sidecarId, tenantId, externalRef: created.Id, running: true, startedAt: new Date() };
  }

  async function containers(label: string): Promise<SidecarHandle[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
    return Container.array().assert(await engine("GET", `/containers/json?all=true&filters=${filters}`)).map(handleOf);
  }

  async function ofAllocation(allocationId: string): Promise<SidecarHandle[]> {
    const found = await containers(`${ALLOCATION_LABEL}=${allocationId}`);
    return found.sort((left, right) => right.generation - left.generation);
  }

  async function find(allocationId: string): Promise<SidecarHandle | null> {
    return (await ofAllocation(allocationId))[0] ?? null;
  }

  function list(): Promise<SidecarHandle[]> {
    return containers(ALLOCATION_LABEL);
  }

  // Also removes containers an interrupted older generation left behind.
  async function stop(handle: SidecarHandle): Promise<void> {
    for (const container of await ofAllocation(handle.allocationId)) {
      if (container.generation <= handle.generation) await remove(container.externalRef);
    }
  }

  return {
    id: "docker",
    // The image is a launch setting: find and stop work by label whatever image a container runs.
    fingerprint: "docker:v1",
    capabilities: [
      { capability: "runtime:posix", state: "available" },
      { capability: "network:outbound", state: "available" },
      { capability: "isolation:workload", state: "available" },
      { capability: "isolation:microvm", state: "blocked" },
    ],
    limits,
    start,
    stop,
    find,
    list,
  };
}
