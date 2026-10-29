import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import type { Backend, SidecarResource } from "./backend.js";

export { createMemoryBackend, type Backend } from "./backend.js";
export { sidecarEnv, type SidecarEnvOpts } from "./sidecar-env.js";

export type CreateTemplateSidecarProvisionerOpts = {
  readonly backend: Backend;
};

type Fence = {
  readonly generation: number;
  readonly destroyedSidecarId?: string;
};

async function settled(operation: Promise<unknown> | undefined): Promise<void> {
  try {
    await operation;
  } catch {
    // The caller of that operation sees its failure; the queue only needs ordering.
  }
}

// At the destroyed generation only the destroyed identity goes: replacement
// ensures a new sidecarId at that same generation, and a delayed destroy must
// not remove it.
export function isDestroyedBy(resource: Pick<SidecarResource, "generation" | "sidecarId">, request: DestroySidecarRequest): boolean {
  return (
    resource.generation < request.generation ||
    (resource.generation === request.generation && resource.sidecarId === request.sidecarId)
  );
}

export function createTemplateSidecarProvisioner({
  backend,
}: CreateTemplateSidecarProvisionerOpts): SidecarProvisioner {
  const fences = new Map<string, Fence>();
  const queues = new Map<string, Promise<unknown>>();

  async function runAfter<T>(previous: Promise<unknown> | undefined, run: () => Promise<T>): Promise<T> {
    await settled(previous);
    return run();
  }

  async function forgetWhenSettled(allocationId: string, pending: Promise<unknown>): Promise<void> {
    await settled(pending);
    if (queues.get(allocationId) === pending) queues.delete(allocationId);
  }

  // A late ensure the hub stopped waiting for still finishes before the
  // destroy that fences it, so the destroy removes what it created.
  function serialize<T>(allocationId: string, run: () => Promise<T>): Promise<T> {
    const pending = runAfter(queues.get(allocationId), run);
    queues.set(allocationId, pending);
    void forgetWhenSettled(allocationId, pending);
    return pending;
  }

  async function ensureSidecar(request: EnsureSidecarRequest): Promise<EnsureSidecarResult> {
    request.signal?.throwIfAborted();
    const fence = fences.get(request.allocationId);
    const resources = await backend.list(request.allocationId);
    const observed = Math.max(fence?.generation ?? 0, ...resources.map((resource) => resource.generation));
    if (request.generation < observed) {
      return {
        kind: "rejected",
        code: "stale_generation",
        message: `Generation ${String(request.generation)} is older than ${String(observed)}`,
        retryable: false,
      };
    }
    if (request.generation === fence?.generation && request.sidecarId === fence.destroyedSidecarId) {
      return {
        kind: "rejected",
        code: "sidecar_destroyed",
        message: `Sidecar ${request.sidecarId} was destroyed`,
        retryable: false,
      };
    }
    const existing = resources.find(
      (resource) => resource.generation === request.generation && resource.sidecarId === request.sidecarId,
    );
    if (existing !== undefined) return { kind: "accepted", externalRef: existing.id };

    if (fence === undefined || request.generation > fence.generation) {
      fences.set(request.allocationId, { generation: request.generation });
    }
    // Throw, never reject, when the outcome is unknown: a rejection tells the
    // hub that nothing exists for this generation.
    const id = await backend.create({
      allocationId: request.allocationId,
      generation: request.generation,
      sidecarId: request.sidecarId,
      tenantId: request.tenantId,
      token: request.token,
      hubWebSocketUrl: request.hubWebSocketUrl,
      ...(request.adapterManifest !== undefined && { adapterManifest: request.adapterManifest }),
    });
    return { kind: "accepted", externalRef: id };
  }

  // Resources are found by their labels, so externalRef is not needed: the hub
  // may crash before recording it.
  async function destroySidecar(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const fence = fences.get(request.allocationId);
    if (fence === undefined || request.generation >= fence.generation) {
      fences.set(request.allocationId, {
        generation: request.generation,
        destroyedSidecarId: request.sidecarId,
      });
    }
    const doomed = (await backend.list(request.allocationId)).filter((resource) => isDestroyedBy(resource, request));
    for (const resource of doomed) {
      await backend.remove(resource.id);
    }
    // "confirmed" promises the sidecar is gone for good, so check rather than assume.
    const remaining = (await backend.list(request.allocationId)).filter((resource) => isDestroyedBy(resource, request));
    if (remaining.length > 0) {
      throw new Error(`Sidecar resources for ${request.allocationId} are still present`);
    }
    return { kind: "destroyed", cleanup: "confirmed" };
  }

  return {
    id: "template",
    apiVersion: 2,
    bindingFingerprint: "template:v1",
    // Declare a capability only when every sidecar this provisioner starts
    // guarantees it; an undeclared capability never matches a rule.
    capabilities: [],
    ensure(request) {
      return serialize(request.allocationId, () => ensureSidecar(request));
    },
    destroy(request) {
      return serialize(request.allocationId, () => destroySidecar(request));
    },
  };
}
