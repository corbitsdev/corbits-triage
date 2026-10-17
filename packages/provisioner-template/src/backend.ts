import type { AdapterManifest } from "@intx/types";

type SidecarLabels = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
};

export type SidecarResource = SidecarLabels & { readonly id: string };

type SidecarLaunch = SidecarLabels & {
  readonly tenantId: string;
  readonly token: string;
  readonly hubWebSocketUrl: string;
  readonly adapterManifest?: AdapterManifest;
};

/**
 * Stands in for a backend SDK such as a container or sandbox API. Replace it
 * with calls to your backend's own client.
 */
export type Backend = {
  /** Starts a sidecar with the launch values in its environment, labelled for lookup. */
  create(launch: SidecarLaunch): Promise<string>;
  list(allocationId: string): Promise<readonly SidecarResource[]>;
  /** Removing a resource that is already gone succeeds. */
  remove(id: string): Promise<void>;
};

export function createMemoryBackend(): Backend {
  const resources = new Map<string, SidecarResource>();
  let next = 0;

  return {
    async create({ allocationId, generation, sidecarId }) {
      next += 1;
      const id = `res_${String(next)}`;
      resources.set(id, { id, allocationId, generation, sidecarId });
      return id;
    },
    async list(allocationId) {
      return [...resources.values()].filter((resource) => resource.allocationId === allocationId);
    },
    async remove(id) {
      resources.delete(id);
    },
  };
}
