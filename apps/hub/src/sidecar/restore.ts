import { schema, type DB } from "@intx/db";
import { and, eq, isNull } from "drizzle-orm";
import type { LocalProcessSidecarProvisioner } from "./local-provisioner.js";
import type { LocalSidecarManifest } from "./manifest-store.js";

/** Respawns local sidecars whose allocation the hub still holds; removes the rest. */
export async function restoreLocalSidecars(
  db: DB["db"],
  local: LocalProcessSidecarProvisioner,
): Promise<void> {
  async function isLocalSidecarLive(manifest: LocalSidecarManifest): Promise<boolean> {
    const row = await db.query.sidecarAllocation.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.sidecarAllocation.id, manifest.allocationId),
        eq(schema.sidecarAllocation.provisionerId, local.provisioner.id),
        eq(schema.sidecarAllocation.status, "allocated"),
        eq(schema.sidecarAllocation.generation, manifest.generation),
        eq(schema.sidecarAllocation.sidecarId, manifest.sidecarId),
        isNull(schema.sidecarAllocation.initializationLeaseId),
      ),
    });
    return row !== undefined;
  }
  await local.restore(isLocalSidecarLive);
}
