import { schema, type DB } from "@intx/db";
import type { SidecarProvisioner, SidecarProvisionerChooser } from "@intx/hub-sessions";
import { and, eq, inArray, or, sql } from "drizzle-orm";

export type CreatePlacementChooserOpts = {
  readonly db: DB["db"];
  readonly local: SidecarProvisioner;
  /** The active deployments the local sidecar advertises. */
  readonly maxDeployments: number;
};

/** Allocations holding one of a provisioner's active slots, counted as stock counts a sidecar's room at placement. */
export async function activeDeployments(db: DB["db"], provisionerId: string): Promise<number> {
  const allocation = schema.sidecarAllocation;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(allocation)
    .where(
      and(
        eq(allocation.provisionerId, provisionerId),
        or(
          inArray(allocation.status, ["provisioning", "allocated"]),
          and(inArray(allocation.status, ["replacing", "releasing", "destroy_failed"]), eq(allocation.deploymentCleanupConfirmed, false)),
        ),
      ),
    );
  if (row === undefined) throw new Error("placement: count query returned no row");
  return row.count;
}

/** The local sidecar until it is full, then the first sandbox that matches. */
export function createPlacementChooser({ db, local, maxDeployments }: CreatePlacementChooserOpts): SidecarProvisionerChooser {
  return async function choosePlacement(candidates) {
    const [first] = candidates;
    if (first === undefined) throw new Error("No matching sidecar provisioners are available");
    if (!candidates.includes(local)) return first;
    const sandbox = candidates.find((candidate) => candidate !== local);
    // With nowhere else to go the deployment still goes local: stock retries a full sidecar's placement with backoff,
    // so it waits there until a deployment ends.
    if (sandbox === undefined) return local;
    return (await activeDeployments(db, local.id)) >= maxDeployments ? sandbox : local;
  };
}
