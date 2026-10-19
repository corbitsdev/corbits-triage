import { createTemplateSidecarProvisioner, sidecarEnv, type Backend } from "@corbits/provisioner-template";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import type { FlyMachine, FlyMachines } from "./machines.js";

export { connectFlyMachines, type FlyMachine, type FlyMachines, type FlyMachineSpec } from "./machines.js";
export { FLY_PLACE } from "./places.js";

const LABEL = {
  hub: "corbits_hub",
  allocation: "corbits_allocation",
  generation: "corbits_generation",
  sidecar: "corbits_sidecar",
} as const;
const DATA_DIR = "/data";
/** Where docs/provisioners/fly.md pushes the root Dockerfile's `sidecar` stage for `app`. */
export function flySidecarImage(app: string): string {
  return `registry.fly.io/${app}:sidecar`;
}

/** One sidecar's guest, as much memory as a Docker sidecar may use; docs/provisioners/docker.md has the measurements. */
const GUEST = { cpu_kind: "shared", cpus: 2, memory_mb: 2048 } as const;

type Labelled = {
  readonly id: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
};

export type FlySidecars = {
  readonly machines: FlyMachines;
  /** Labels every machine, so hubs sharing a Fly app never touch each other's sidecars. */
  readonly hubId: string;
};

export type CreateFlySidecarProvisionerOpts = FlySidecars & {
  /** The sidecar image in Fly's registry, which runs the stock sidecar as its command. */
  readonly image: string;
  /** Unset, Fly picks the region. */
  readonly region?: string;
  /** The hub's adapter manifest at the paths the image holds its modules. */
  readonly adapterManifest: AdapterManifest;
  /** Where machines reach the hub: a public wss:// URL. */
  readonly hubWebSocketUrl: string;
};

/** Machines missing one of our labels are not ours, so they are left out. */
function labelled({ id, metadata }: FlyMachine): Labelled | undefined {
  const { [LABEL.allocation]: allocationId, [LABEL.generation]: generation, [LABEL.sidecar]: sidecarId } = metadata;
  if (allocationId === undefined || generation === undefined || sidecarId === undefined) return undefined;
  return { id, allocationId, generation: Number(generation), sidecarId };
}

async function listMachines({ machines, hubId }: FlySidecars, allocationId?: string): Promise<Labelled[]> {
  const listed = await machines.list({ [LABEL.hub]: hubId, ...(allocationId !== undefined && { [LABEL.allocation]: allocationId }) });
  return listed.map(labelled).filter((machine) => machine !== undefined);
}

/**
 * One Fly Machine per sidecar, labelled through its metadata with this hub, the allocation, the generation and the
 * sidecar id. It destroys itself when the sidecar exits.
 */
export function createFlySidecarProvisioner({ machines, hubId, image, region, adapterManifest, hubWebSocketUrl }: CreateFlySidecarProvisionerOpts): SidecarProvisioner {
  // Fly's listing lags: a new machine may be missing and a destroyed one still shown, so both are remembered by id.
  const created = new Map<string, Labelled>();
  const destroyed = new Set<string>();

  const backend: Backend = {
    async create({ allocationId, generation, sidecarId, token }) {
      const id = await machines.create({
        ...(region !== undefined && { region }),
        config: {
          image,
          env: sidecarEnv({ hubWebSocketUrl, sidecarId, token, dataDir: DATA_DIR, adapterManifest }),
          metadata: {
            [LABEL.hub]: hubId,
            [LABEL.allocation]: allocationId,
            [LABEL.generation]: String(generation),
            [LABEL.sidecar]: sidecarId,
          },
          guest: GUEST,
          restart: { policy: "no" },
          auto_destroy: true,
        },
      });
      created.set(id, { id, allocationId, generation, sidecarId });
      return id;
    },
    async list(allocationId) {
      const listed = new Map((await listMachines({ machines, hubId }, allocationId)).map((machine) => [machine.id, machine]));
      for (const machine of created.values()) {
        if (machine.allocationId === allocationId) listed.set(machine.id, machine);
      }
      return [...listed.values()].filter((machine) => !destroyed.has(machine.id));
    },
    async remove(id) {
      await machines.destroy(id);
      await machines.waitDestroyed(id);
      const machine = await machines.get(id);
      if (machine !== undefined && machine.state !== "destroyed") throw new Error(`Fly machine ${id} is ${machine.state}, not destroyed`);
      destroyed.add(id);
      created.delete(id);
    },
  };

  return {
    ...createTemplateSidecarProvisioner({ backend }),
    id: "fly",
    // The image is a launch setting: machines are found by label whatever image they run.
    bindingFingerprint: `fly:v1:${machines.app}:${hubId}`,
    capabilities: [
      { capability: "isolation:workload", state: "available" },
      { capability: "network:outbound", state: "available" },
    ],
  };
}

/**
 * Destroys this hub's machines whose allocation or probe is no longer active, such as one a crash left unrecorded.
 * The active set is read after the machines, so a machine created meanwhile is never swept.
 */
export async function sweepFlySidecars(sidecars: FlySidecars, readActiveAllocationIds: () => Promise<ReadonlySet<string>>): Promise<number> {
  const listed = await listMachines(sidecars);
  const active = await readActiveAllocationIds();
  let removed = 0;
  for (const machine of listed) {
    if (active.has(machine.allocationId)) continue;
    await sidecars.machines.destroy(machine.id);
    removed += 1;
  }
  return removed;
}
