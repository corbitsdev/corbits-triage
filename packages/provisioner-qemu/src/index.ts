import { sidecarEnv } from "@corbits/provisioner-template";
import { type } from "arktype";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";

export { QEMU_PLACE } from "./places.js";

const DATA_DIR = "/data";

const Failure = type({ kind: "'rejected'", code: "string", message: "string", retryable: "boolean" });
const Ensured = type({ kind: "'accepted'", externalRef: "string" }).or(Failure);
const Destroyed = type({ kind: "'destroyed'", cleanup: "'confirmed'" }).or(Failure);
const Swept = type({ removed: "number" });

export type QemuHost = {
  /** The host agent's address, behind its TLS proxy. */
  readonly url: string;
  readonly token: string;
};

export type QemuSidecars = {
  readonly host: QemuHost;
  /** Tags every VM, so hubs sharing a host never touch each other's sidecars. */
  readonly hubId: string;
};

export type CreateQemuSidecarProvisionerOpts = QemuSidecars & {
  /** The hub's adapter manifest at the paths the image holds its modules. */
  readonly adapterManifest: AdapterManifest;
  /** Where VMs reach the hub: its public `wss://` address. */
  readonly hubWebSocketUrl: string;
};

async function call(host: QemuHost, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(new URL(route, host.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(signal !== undefined && { signal }),
  });
  if (!response.ok) throw new Error(`QEMU host ${route} answered ${String(response.status)}: ${await response.text()}`);
  return response.json();
}

export async function pingQemuHost(host: QemuHost): Promise<void> {
  await call(host, "/health", undefined, AbortSignal.timeout(2_000));
}

/** One microVM per sidecar on a Linux KVM host, through the host agent in ./agent.ts. */
export function createQemuSidecarProvisioner({ host, hubId, adapterManifest, hubWebSocketUrl }: CreateQemuSidecarProvisionerOpts): SidecarProvisioner {
  return {
    id: "qemu",
    apiVersion: 2,
    bindingFingerprint: `qemu:v1:${new URL(host.url).origin}:${hubId}`,
    capabilities: [
      { capability: "isolation:workload", state: "available" },
      { capability: "network:outbound", state: "available" },
    ],
    async ensure({ allocationId, generation, sidecarId, token, signal }) {
      const env = sidecarEnv({ hubWebSocketUrl, sidecarId, token, dataDir: DATA_DIR, adapterManifest });
      return Ensured.assert(await call(host, "/ensure", { hubId, allocationId, generation, sidecarId, env }, signal));
    },
    async destroy({ allocationId, generation, sidecarId, signal }) {
      return Destroyed.assert(await call(host, "/destroy", { hubId, allocationId, generation, sidecarId }, signal));
    },
  };
}

/** Removes this hub's VMs whose allocation or probe is no longer active, such as one a crash left unrecorded. */
export async function sweepQemuSidecars({ host, hubId }: QemuSidecars, activeAllocationIds: ReadonlySet<string>): Promise<number> {
  return Swept.assert(await call(host, "/sweep", { hubId, activeAllocationIds: [...activeAllocationIds] })).removed;
}
