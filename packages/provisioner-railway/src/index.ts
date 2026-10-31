import { createTemplateSidecarProvisioner, sidecarEnv, type Backend } from "@corbits/provisioner-template";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import type { AdapterManifest } from "@intx/types";
import { RailwayCreateRefused, RUNNING_WAIT_MS, type RailwaySandboxes, type SandboxSummary } from "./sandboxes.js";

export {
  connectRailwaySandboxes,
  RailwayCreateRefused,
  sidecarTemplate,
  type RailwayConnection,
  type RailwaySandboxes,
  type SandboxSummary,
  type SidecarTemplateSource,
} from "./sandboxes.js";
export { RAILWAY_PLACE } from "./places.js";

/** Railway sandboxes have no labels, so ours carry these create-time variables. They are not secret. */
const LABEL = {
  hub: "CORBITS_HUB",
  allocation: "CORBITS_ALLOCATION",
  generation: "CORBITS_GENERATION",
  sidecar: "CORBITS_SIDECAR",
} as const;
const LABEL_NAMES = Object.values(LABEL);
const DATA_DIR = "/var/lib/sidecar";

type Labels = {
  readonly allocationId: string;
  readonly generation: number;
  readonly sidecarId: string;
};

type Labelled = Labels & { readonly id: string };

export type RailwaySidecars = {
  readonly sandboxes: RailwaySandboxes;
  /**
   * Labels every sandbox. The environment is meant for this hub alone; the id keeps a second hub pointed at it by
   * mistake from touching this one's sidecars.
   */
  readonly hubId: string;
};

export type CreateRailwaySidecarProvisionerOpts = RailwaySidecars & {
  readonly environmentId: string;
  /** The hub's adapter manifest at the paths the template holds its modules. */
  readonly adapterManifest: AdapterManifest;
  /** The hub's public `wss://` address: sandboxes cannot reach its private one. */
  readonly hubWebSocketUrl: string;
};

function labelsOf(hubId: string, variables: Readonly<Record<string, string>> | undefined): Labels | null {
  if (variables?.[LABEL.hub] !== hubId) return null;
  const generation = Number(variables[LABEL.generation]);
  const allocationId = variables[LABEL.allocation];
  const sidecarId = variables[LABEL.sidecar];
  if (!Number.isInteger(generation) || allocationId === undefined || sidecarId === undefined) return null;
  return { allocationId, generation, sidecarId };
}

/**
 * Finds this hub's sandboxes by their label variables, read once per sandbox and remembered, since they never change.
 * Sandboxes without this hub's labels are never touched beyond that read.
 */
function createLabelReader({ sandboxes, hubId }: RailwaySidecars) {
  /** null: not one of this hub's sandboxes. */
  const known = new Map<string, Labels | null>();

  async function read(sandbox: SandboxSummary): Promise<Labels | null> {
    const labels = labelsOf(hubId, await sandboxes.readVariables(sandbox.id, LABEL_NAMES));
    known.set(sandbox.id, labels);
    return labels;
  }

  /**
   * This hub's sandboxes, and the unknown ones that cannot run a command because they are being created or destroyed:
   * any of those may be one this hub created before a restart. One this hub created since is known from the moment
   * Railway returns its id. An unknown failed sandbox is never one of ours with a sidecar in it, and is left alone.
   */
  async function all(): Promise<{ ours: Labelled[]; unsettled: string[] }> {
    const listed = await sandboxes.list();
    const present = new Set(listed.filter((sandbox) => sandbox.status !== "DESTROYED").map((sandbox) => sandbox.id));
    for (const id of known.keys()) {
      if (!present.has(id)) known.delete(id);
    }
    const ours: Labelled[] = [];
    const unsettled: string[] = [];
    for (const sandbox of listed) {
      if (!present.has(sandbox.id)) continue;
      const cached = known.get(sandbox.id);
      if (cached === undefined && (sandbox.status === "CREATING" || sandbox.status === "DESTROYING")) {
        unsettled.push(sandbox.id);
        continue;
      }
      if (cached === undefined && sandbox.status !== "RUNNING") continue;
      const labels = cached === undefined ? await read(sandbox) : cached;
      if (labels !== null) ours.push({ id: sandbox.id, ...labels });
    }
    return { ours, unsettled };
  }

  function remember(id: string, labels: Labels): void {
    known.set(id, labels);
  }

  return { all, remember };
}

/**
 * One sandbox per sidecar, created from the sidecar template and labelled with this hub, the allocation, the generation
 * and the sidecar id. The sidecar runs as a detached command whose environment alone holds its token and key.
 */
export function createRailwaySidecarProvisioner({
  sandboxes,
  hubId,
  environmentId,
  adapterManifest,
  hubWebSocketUrl,
}: CreateRailwaySidecarProvisionerOpts): SidecarProvisioner {
  const labels = createLabelReader({ sandboxes, hubId });

  async function startSidecar(id: string, sidecarId: string, token: string): Promise<void> {
    await sandboxes.waitUntilRunning(id);
    await sandboxes.launch(id, sidecarEnv({ hubWebSocketUrl, sidecarId, token, dataDir: DATA_DIR, adapterManifest }));
  }

  const backend: Backend = {
    async create({ allocationId, generation, sidecarId, token }) {
      const id = await sandboxes.create({
        [LABEL.hub]: hubId,
        [LABEL.allocation]: allocationId,
        [LABEL.generation]: String(generation),
        [LABEL.sidecar]: sidecarId,
      });
      labels.remember(id, { allocationId, generation, sidecarId });
      try {
        await startSidecar(id, sidecarId, token);
      } catch (error) {
        await sandboxes.destroy(id);
        throw error;
      }
      return id;
    },
    async list(allocationId) {
      return (await labels.all()).ours.filter((sandbox) => sandbox.allocationId === allocationId);
    },
    async remove(id) {
      await sandboxes.destroy(id);
    },
  };
  const template = createTemplateSidecarProvisioner({ backend });

  return {
    ...template,
    id: "railway-sandbox",
    bindingFingerprint: `railway:v1:${environmentId}:${hubId}`,
    capabilities: [{ capability: "isolation:workload", state: "available" }],
    // The hub's connect deadline has to cover waitUntilRunning, which already waits this long.
    connectTimeoutMs: RUNNING_WAIT_MS,
    async ensure(request) {
      // No sandbox is created from a template Railway has not built.
      const build = await unlessAborted(sandboxes.templateReady(), request.signal);
      if (build.kind === "aborted") {
        return { kind: "rejected", code: "template_not_ready", message: "The sidecar template was still being built when the hub stopped waiting", retryable: true };
      }
      if (build.kind === "failed") {
        return { kind: "rejected", code: "template_not_ready", message: `The sidecar template did not build: ${String(build.error)}`, retryable: true };
      }
      try {
        return await template.ensure(request);
      } catch (error) {
        if (!(error instanceof RailwayCreateRefused)) throw error;
        return { kind: "rejected", code: "railway_refused", message: error.message, retryable: false };
      }
    },
    async destroy(request) {
      const result = await template.destroy(request);
      // Thrown, so the hub tries again: "confirmed" must not be said while one of them may be this sidecar's.
      const { unsettled } = await labels.all();
      if (unsettled.length > 0) {
        throw new Error(`Railway sandboxes ${unsettled.join(", ")} are being created or destroyed and may be this hub's`);
      }
      return result;
    },
  };
}

type Outcome = { readonly kind: "done" } | { readonly kind: "failed"; readonly error: unknown } | { readonly kind: "aborted" };

async function outcomeOf(work: Promise<void>): Promise<Outcome> {
  try {
    await work;
    return { kind: "done" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/** How `work` ended, or that `signal` aborted first; `work` is left running. */
async function unlessAborted(work: Promise<void>, signal: AbortSignal | undefined): Promise<Outcome> {
  if (signal === undefined) return outcomeOf(work);
  if (signal.aborted) return { kind: "aborted" };
  const aborted = Promise.withResolvers<Outcome>();
  function onAbort(): void {
    aborted.resolve({ kind: "aborted" });
  }
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([outcomeOf(work), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export type SweepResult = {
  readonly removed: number;
  /** Unknown sandboxes being created or destroyed, which may be this hub's; sweep again once they settle. */
  readonly unsettled: number;
};

/**
 * Destroys this hub's sandboxes whose allocation or probe is no longer active, such as one a crash left unrecorded.
 * The active set is read after the sandboxes, so a sandbox created meanwhile is never swept.
 */
export async function sweepRailwaySidecars(sidecars: RailwaySidecars, activeAllocationIds: () => Promise<ReadonlySet<string>>): Promise<SweepResult> {
  const { ours, unsettled } = await createLabelReader(sidecars).all();
  const active = await activeAllocationIds();
  let removed = 0;
  for (const sandbox of ours) {
    if (active.has(sandbox.allocationId)) continue;
    await sidecars.sandboxes.destroy(sandbox.id);
    removed += 1;
  }
  return { removed, unsettled: unsettled.length };
}
