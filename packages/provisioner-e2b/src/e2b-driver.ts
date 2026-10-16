import { pathToFileURL } from "node:url";
import { type } from "arktype";
import type { AdapterManifest } from "@intx/types";
import type { SidecarDriver, SidecarEnv, SidecarHandle, SidecarLaunchSpec } from "@corbits/provisioner";

export const E2B_API_URL = "https://api.e2b.app";
export const E2B_SANDBOX_URL = "https://sandbox.e2b.app";

/** E2B kills a sandbox at its timeout, so a hub that dies without destroying leaks it for at most this long. One hour is the Hobby plan's cap. */
const SANDBOX_TIMEOUT_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 60_000;
const ENVD_PORT = "49983";
/** Where the repo sits in the template image (`e2b.Dockerfile`). */
const IMAGE_ROOT = "/app";
const DATA_DIR = "/home/user/sidecar";
const SIDECAR_COMMAND = `mkdir -p ${DATA_DIR} && cd ${IMAGE_ROOT}/vendor/interchange && exec bun --conditions=intx-src apps/sidecar/src/index.ts >> ${DATA_DIR}/sidecar.log 2>&1`;

const CreatedSandbox = type({ sandboxID: "string", envdAccessToken: "string" });
const ListedSandboxes = type({
  sandboxID: "string",
  state: "'running' | 'paused'",
  "metadata?": "Record<string, string>",
}).array();
type ListedSandbox = typeof ListedSandboxes.infer[number];
const ApiError = type({ "message?": "string", "error_code?": "string" });
const StreamMessage = type({
  "event?": { "start?": { pid: "number" } },
  "error?": { "code?": "string", "message?": "string" },
});

export type E2bDriverOpts = {
  readonly apiKey: string;
  readonly template: string;
  readonly apiUrl: string;
  readonly sandboxUrl: string;
  /** The hub's checkout; `file:` adapter specifiers under it are moved to the image's copy. */
  readonly hubRoot: string;
};

async function apiError(response: Response): Promise<Error> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Error(`E2B ${String(response.status)}: ${text}`);
  }
  const parsed = ApiError(body);
  if (parsed instanceof type.errors) return new Error(`E2B ${String(response.status)}: ${text}`);
  const code = parsed.error_code === undefined ? "" : ` ${parsed.error_code}`;
  return new Error(`E2B ${String(response.status)}${code}: ${parsed.message ?? text}`);
}

function frame(message: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(5 + json.length);
  new DataView(bytes.buffer).setUint32(1, json.length);
  bytes.set(json, 5);
  return bytes;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left);
  joined.set(right, left.length);
  return joined;
}

/** Reads Connect frames until envd reports the process started; closing the stream then leaves the process running. */
async function readStartedPid(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader();
  let buffered: Uint8Array = new Uint8Array(0);
  try {
    for (;;) {
      while (buffered.length >= 5) {
        const length = new DataView(buffered.buffer, buffered.byteOffset).getUint32(1);
        if (buffered.length < 5 + length) break;
        const flags = buffered[0];
        const message = StreamMessage.assert(JSON.parse(new TextDecoder().decode(buffered.subarray(5, 5 + length))));
        buffered = buffered.subarray(5 + length);
        if (message.event?.start !== undefined) return message.event.start.pid;
        if (flags === 2) throw new Error(`envd ended the sidecar start: ${message.error?.message ?? "no start event"}`);
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("envd closed the stream before the sidecar started");
      buffered = concat(buffered, value);
    }
  } finally {
    await reader.cancel();
  }
}

function toImagePaths(manifestJson: string, hubRoot: string): string {
  const hubRootUrl = pathToFileURL(hubRoot).href;
  const imageRootUrl = pathToFileURL(IMAGE_ROOT).href;
  const manifest = JSON.parse(manifestJson) as AdapterManifest;
  return JSON.stringify(manifest.map((row) =>
    row.specifier.startsWith(`${hubRootUrl}/`) ? { ...row, specifier: imageRootUrl + row.specifier.slice(hubRootUrl.length) } : row));
}

function handleOf(sandbox: ListedSandbox): SidecarHandle | null {
  const { intxAllocation, intxGeneration, intxSidecar } = sandbox.metadata ?? {};
  if (intxAllocation === undefined || intxGeneration === undefined || intxSidecar === undefined) return null;
  return {
    allocationId: intxAllocation,
    generation: Number(intxGeneration),
    sidecarId: intxSidecar,
    externalRef: sandbox.sandboxID,
    running: sandbox.state === "running",
  };
}

/** One E2B sandbox (a Firecracker microVM) per allocation; the sandbox's metadata is the durable hold. */
export function createE2bDriver({ apiKey, template, apiUrl, sandboxUrl, hubRoot }: E2bDriverOpts): SidecarDriver {
  const fingerprint = "e2b:v1";

  function api(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function kill(sandboxId: string): Promise<void> {
    const response = await api(`/sandboxes/${encodeURIComponent(sandboxId)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw await apiError(response);
  }

  async function startSidecar(sandboxId: string, accessToken: string, env: SidecarEnv): Promise<void> {
    const response = await fetch(`${sandboxUrl}/process.Process/Start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/connect+json",
        "E2b-Sandbox-Id": sandboxId,
        "E2b-Sandbox-Port": ENVD_PORT,
        "X-Access-Token": accessToken,
      },
      body: frame({
        process: {
          cmd: "/bin/bash",
          args: ["-l", "-c", SIDECAR_COMMAND],
          envs: { ...env, SIDECAR_ADAPTER_MANIFEST: toImagePaths(env.SIDECAR_ADAPTER_MANIFEST, hubRoot), SIDECAR_DATA_DIR: DATA_DIR },
        },
        stdin: false,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok || response.body === null) throw await apiError(response);
    await readStartedPid(response.body);
  }

  return {
    id: "e2b",
    fingerprint,
    capabilities: [
      { capability: "runtime:posix", state: "available" },
      { capability: "network:outbound", state: "available" },
      { capability: "isolation:workload", state: "available" },
      { capability: "isolation:microvm", state: "available" },
    ],
    async start(launch: SidecarLaunchSpec, env: SidecarEnv): Promise<SidecarHandle> {
      const response = await api("/v2/sandboxes", {
        method: "POST",
        body: JSON.stringify({
          templateID: template,
          timeout: SANDBOX_TIMEOUT_SECONDS,
          autoPause: false,
          metadata: {
            intxBinding: fingerprint,
            intxAllocation: launch.allocationId,
            intxGeneration: String(launch.generation),
            intxSidecar: launch.sidecarId,
          },
        }),
      });
      if (!response.ok) throw await apiError(response);
      const sandbox = CreatedSandbox.assert(await response.json());
      try {
        await startSidecar(sandbox.sandboxID, sandbox.envdAccessToken, env);
      } catch (error) {
        await kill(sandbox.sandboxID);
        throw error;
      }
      return {
        allocationId: launch.allocationId,
        generation: launch.generation,
        sidecarId: launch.sidecarId,
        externalRef: sandbox.sandboxID,
        running: true,
      };
    },
    async stop(handle) {
      await kill(handle.externalRef);
    },
    async find(allocationId) {
      const metadata = new URLSearchParams({ intxBinding: fingerprint, intxAllocation: allocationId }).toString();
      const query = new URLSearchParams({ metadata, state: "running,paused", limit: "100" });
      const response = await api(`/v2/sandboxes?${query.toString()}`);
      if (!response.ok) throw await apiError(response);
      const handles = ListedSandboxes.assert(await response.json()).map(handleOf).filter((handle) => handle !== null);
      if (handles.length === 0) return null;
      return handles.reduce((newest, handle) => handle.generation > newest.generation ? handle : newest);
    },
  };
}
