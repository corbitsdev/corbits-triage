import { schema, type DB } from "@intx/db";
import type { SidecarProvisioner, SidecarProvisionerChooser } from "@intx/hub-sessions";
import { settled } from "@corbits/common";
import type { DeployedVersions } from "@corbits/triage-contracts";
import { CAPACITY_UNAVAILABLE } from "./host-capacity.js";
import { and, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";

export type CreatePlacementChooserOpts = {
  readonly db: DB["db"];
  readonly local: SidecarProvisioner;
  /** The sidecar processes the local provisioner runs at once. */
  readonly maxSidecars: number;
  readonly now?: () => number;
};

/**
 * How long a local pick counts before its allocation row does. Stock writes that row right after the chooser answers,
 * so once it lands the pick counts twice until this passes, which sends a deployment to a sandbox early, never late.
 */
const RESERVATION_MS = 30_000;

const allocation = schema.sidecarAllocation;
const probe = schema.workflowProbe;

/** Stock's probe statuses short of an outcome, as its probe store counts them. */
const ACTIVE_PROBE_STATUSES = ["pending", "provisioning", "probing", "releasing"] as const;

/**
 * A placement the local provisioner refused for room, which stock moves to `replacing` with the code until it tries
 * again: it has no sidecar, its cleanup confirmed since nothing started, but takes the next one that frees.
 */
function waitsForSlot(): SQL | undefined {
  return and(eq(allocation.status, "replacing"), eq(allocation.failureCode, CAPACITY_UNAVAILABLE));
}

/** An allocation whose sidecar may still run: placed, or ended with its cleanup not yet confirmed. */
function holdsSlot(): SQL | undefined {
  return or(
    inArray(allocation.status, ["provisioning", "allocated"]),
    and(inArray(allocation.status, ["replacing", "releasing", "destroy_failed"]), eq(allocation.deploymentCleanupConfirmed, false)),
  );
}

async function countAllocations(db: DB["db"], where: SQL | undefined): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(allocation).where(where);
  if (row === undefined) throw new Error("placement: count query returned no row");
  return row.count;
}

async function activeProbes(db: DB["db"], provisionerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(probe)
    .where(and(eq(probe.provisionerId, provisionerId), inArray(probe.status, [...ACTIVE_PROBE_STATUSES])));
  if (row === undefined) throw new Error("placement: count query returned no row");
  return row.count;
}

/** Deployments and probes with a sidecar of the provisioner's: each probe runs in a sidecar of its own too. */
async function activeDeployments(db: DB["db"], provisionerId: string): Promise<number> {
  return (await activeProbes(db, provisionerId)) + (await countAllocations(db, and(eq(allocation.provisionerId, provisionerId), holdsSlot())));
}

function waitingDeployments(db: DB["db"], provisionerId: string): Promise<number> {
  return countAllocations(db, and(eq(allocation.provisionerId, provisionerId), waitsForSlot()));
}

/** Deployments elsewhere whose workflow requires no capability, so the local sidecar was a candidate for them. */
async function overflowDeployments(db: DB["db"], localId: string): Promise<number> {
  const launchSpec = schema.workflowRunLaunchSpec;
  const requires = sql`exists (select 1 from jsonb_array_elements(coalesce(${launchSpec.frozenApprovalBundle} -> 'projection' -> 'sidecarPlacement' -> 'capabilities', '[]'::jsonb)) as rule where rule ->> 'effect' = 'require')`;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(allocation)
    .innerJoin(launchSpec, eq(launchSpec.anchorRunId, allocation.anchorRunId))
    .where(and(ne(allocation.provisionerId, localId), holdsSlot(), sql`not ${requires}`));
  if (row === undefined) throw new Error("placement: count query returned no row");
  return row.count;
}

export async function localSidecarUsage(db: DB["db"], local: SidecarProvisioner, cap: number): Promise<DeployedVersions["sidecar"]> {
  return {
    active: await activeDeployments(db, local.id),
    waiting: await waitingDeployments(db, local.id),
    cap,
    overflow: await overflowDeployments(db, local.id),
  };
}

/**
 * A local sidecar until the cap is reached, then the first sandbox that matches. Decisions run one at a time, and each
 * local pick holds a slot until its allocation is counted, so placements side by side cannot both take the last one.
 */
export function createPlacementChooser({ db, local, maxSidecars, now = Date.now }: CreatePlacementChooserOpts): SidecarProvisionerChooser {
  let reservations: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  async function decide(candidates: readonly SidecarProvisioner[]): Promise<SidecarProvisioner> {
    const [first] = candidates;
    if (first === undefined) throw new Error("No matching sidecar provisioners are available");
    if (!candidates.includes(local)) return first;
    const sandbox = candidates.find((candidate) => candidate !== local);
    // With nowhere else to go the deployment still goes local, where the provisioner refuses it for capacity while the
    // cap is reached and stock retries the placement with backoff.
    if (sandbox === undefined) return local;
    const at = now();
    reservations = reservations.filter((until) => until > at);
    // A placement waiting for a slot takes the next one that frees, so a new deployment would only queue behind it.
    const taken = (await activeDeployments(db, local.id)) + (await waitingDeployments(db, local.id)) + reservations.length;
    if (taken >= maxSidecars) return sandbox;
    reservations.push(at + RESERVATION_MS);
    return local;
  }

  async function after(previous: Promise<void>, candidates: readonly SidecarProvisioner[]): Promise<SidecarProvisioner> {
    await previous;
    return decide(candidates);
  }

  return function choosePlacement(candidates) {
    const decision = after(queue, candidates);
    queue = settled(decision);
    return decision;
  };
}
