import { RateLimitError } from "e2b";
import type {
  DestroySidecarRequest,
  DestroySidecarResult,
  EnsureSidecarRequest,
  EnsureSidecarResult,
  SidecarProvisioner,
} from "@intx/hub-sessions";
import { settled } from "@corbits/common";
import { isDestroyedBy, sidecarEnv } from "@corbits/provisioner-template";
import type { AdapterManifest } from "@intx/types";
import type { E2bApi, E2bSandbox } from "./e2b.js";

export { connectE2b, type E2bApi, type E2bCommand, type E2bSandbox } from "./e2b.js";
export { E2B_PLACE } from "./places.js";

const LABEL = {
  hub: "corbits_hub",
  allocation: "corbits_allocation",
  generation: "corbits_generation",
  sidecar: "corbits_sidecar",
} as const;
/** The E2B template sandboxes start from, which template.ts builds. */
export const E2B_SIDECAR_TEMPLATE = "corbits-triage-sidecar";
/** Where the template holds Interchange. */
const INTERCHANGE_DIR = "/app/vendor/interchange";
const DATA_DIR = "/home/user/sidecar";

type Labelled = { readonly sandboxId: string; readonly allocationId: string; readonly generation: number; readonly sidecarId: string };

export type E2bSidecars = {
  readonly e2b: E2bApi;
  /** Labels every sandbox, so hubs sharing an E2B team never touch each other's sidecars. */
  readonly hubId: string;
};

export type CreateE2bSidecarProvisionerOpts = E2bSidecars & {
  /** The hub's adapter manifest at the paths the template holds its modules. */
  readonly adapterManifest: AdapterManifest;
  /** Where sandboxes reach the hub: a public wss:// URL. */
  readonly hubWebSocketUrl: string;
};

type Fence = {
  readonly generation: number;
  readonly destroyedSidecarId?: string;
};

/** Sandboxes missing one of our labels are not ours, so they are left out. */
function labelled({ sandboxId, metadata }: E2bSandbox): Labelled | undefined {
  const { [LABEL.allocation]: allocationId, [LABEL.generation]: generation, [LABEL.sidecar]: sidecarId } = metadata;
  if (allocationId === undefined || generation === undefined || sidecarId === undefined) return undefined;
  return { sandboxId, allocationId, generation: Number(generation), sidecarId };
}

async function listSandboxes({ e2b, hubId }: E2bSidecars, allocationId?: string): Promise<Labelled[]> {
  const sandboxes = await e2b.list({ [LABEL.hub]: hubId, ...(allocationId !== undefined && { [LABEL.allocation]: allocationId }) });
  return sandboxes.map(labelled).filter((sandbox) => sandbox !== undefined);
}

/** One E2B sandbox per sidecar, labelled with this hub, the allocation, the generation and the sidecar id. */
export function createE2bSidecarProvisioner({ e2b, hubId, adapterManifest, hubWebSocketUrl }: CreateE2bSidecarProvisionerOpts): SidecarProvisioner {
  const sidecars = { e2b, hubId };
  const fences = new Map<string, Fence>();
  const queues = new Map<string, Promise<unknown>>();
  /** Sandboxes created here that E2B's listing, up to a second behind, has not shown yet. */
  const unlisted = new Map<string, Labelled>();

  async function sandboxesOf(allocationId: string): Promise<Labelled[]> {
    const listed = await listSandboxes(sidecars, allocationId);
    for (const sandbox of listed) unlisted.delete(sandbox.sandboxId);
    return [...listed, ...[...unlisted.values()].filter((sandbox) => sandbox.allocationId === allocationId)];
  }

  async function create(request: EnsureSidecarRequest): Promise<string> {
    const metadata = {
      [LABEL.hub]: hubId,
      [LABEL.allocation]: request.allocationId,
      [LABEL.generation]: String(request.generation),
      [LABEL.sidecar]: request.sidecarId,
    };
    return e2b.create(metadata, {
      cmd: `mkdir -p ${DATA_DIR} && exec bun --conditions=intx-src apps/sidecar/src/index.ts`,
      cwd: INTERCHANGE_DIR,
      envs: sidecarEnv({ hubWebSocketUrl, sidecarId: request.sidecarId, token: request.token, dataDir: DATA_DIR, adapterManifest }),
    });
  }

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
    const sandboxes = await sandboxesOf(request.allocationId);
    const observed = Math.max(fence?.generation ?? 0, ...sandboxes.map((sandbox) => sandbox.generation));
    if (request.generation < observed) {
      return {
        kind: "rejected",
        code: "stale_generation",
        message: `Generation ${String(request.generation)} is older than ${String(observed)}`,
        retryable: false,
      };
    }
    if (request.generation === fence?.generation && request.sidecarId === fence.destroyedSidecarId) {
      return { kind: "rejected", code: "sidecar_destroyed", message: `Sidecar ${request.sidecarId} was destroyed`, retryable: false };
    }
    const existing = sandboxes.find((sandbox) => sandbox.generation === request.generation && sandbox.sidecarId === request.sidecarId);
    if (existing !== undefined) return { kind: "accepted", externalRef: existing.sandboxId };

    if (fence === undefined || request.generation > fence.generation) {
      fences.set(request.allocationId, { generation: request.generation });
    }
    try {
      const sandboxId = await create(request);
      unlisted.set(sandboxId, { sandboxId, allocationId: request.allocationId, generation: request.generation, sidecarId: request.sidecarId });
      return { kind: "accepted", externalRef: sandboxId };
    } catch (error) {
      // E2B refuses a sandbox over the team's concurrency limit this way.
      if (error instanceof RateLimitError) return { kind: "rejected", code: "capacity_unavailable", message: error.message, retryable: true };
      throw error;
    }
  }

  async function destroySidecar(request: DestroySidecarRequest): Promise<DestroySidecarResult> {
    const fence = fences.get(request.allocationId);
    if (fence === undefined || request.generation >= fence.generation) {
      fences.set(request.allocationId, { generation: request.generation, destroyedSidecarId: request.sidecarId });
    }
    // A killed sandbox stays listed for a moment, so each is confirmed gone by id.
    for (const { sandboxId } of (await sandboxesOf(request.allocationId)).filter((sandbox) => isDestroyedBy(sandbox, request))) {
      await e2b.kill(sandboxId);
      if (await e2b.exists(sandboxId)) throw new Error(`Sidecar sandbox ${sandboxId} for ${request.allocationId} is still present`);
      unlisted.delete(sandboxId);
    }
    return { kind: "destroyed", cleanup: "confirmed" };
  }

  return {
    id: "e2b",
    apiVersion: 2,
    // The template is a launch setting: sandboxes are found by label whatever template they run.
    bindingFingerprint: `e2b:v1:${hubId}`,
    capabilities: [
      { capability: "isolation:workload", state: "available" },
      { capability: "network:outbound", state: "available" },
    ],
    ensure(request) {
      return serialize(request.allocationId, () => ensureSidecar(request));
    },
    destroy(request) {
      return serialize(request.allocationId, () => destroySidecar(request));
    },
  };
}

/**
 * Kills this hub's sandboxes whose allocation or probe is no longer active, such as one a crash left unrecorded, and
 * restarts the timeout of the rest, which E2B would otherwise kill after an hour. Resolves with how many it killed.
 */
export async function tendE2bSidecars(sidecars: E2bSidecars, readActiveAllocationIds: () => Promise<ReadonlySet<string>>): Promise<number> {
  // Listed before the active ids are read: an allocation is recorded before its sandbox is created, so a sandbox an
  // ensure creates in between is either unlisted or held.
  const sandboxes = await listSandboxes(sidecars);
  const activeAllocationIds = await readActiveAllocationIds();
  let removed = 0;
  for (const sandbox of sandboxes) {
    if (activeAllocationIds.has(sandbox.allocationId)) {
      await sidecars.e2b.extend(sandbox.sandboxId);
      continue;
    }
    await sidecars.e2b.kill(sandbox.sandboxId);
    removed += 1;
  }
  return removed;
}
