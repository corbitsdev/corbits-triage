import { schema, type DB } from "@intx/db";
import { and, eq, isNull } from "drizzle-orm";
import type { DriverProvisioner } from "@corbits/provisioner";
import type { LocalProcessDriver, LocalSidecarManifest } from "@corbits/provisioner-local";

export async function restoreLocalSidecars(
  db: DB["db"],
  driver: LocalProcessDriver,
  seam: DriverProvisioner,
): Promise<void> {
  async function isLocalSidecarLive(manifest: LocalSidecarManifest): Promise<boolean> {
    const row = await db.query.sidecarAllocation.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.sidecarAllocation.id, manifest.allocationId),
        eq(schema.sidecarAllocation.provisionerId, driver.id),
        eq(schema.sidecarAllocation.status, "allocated"),
        eq(schema.sidecarAllocation.generation, manifest.generation),
        eq(schema.sidecarAllocation.sidecarId, manifest.sidecarId),
        isNull(schema.sidecarAllocation.initializationLeaseId),
      ),
    });
    return row !== undefined;
  }
  await driver.restore(seam, isLocalSidecarLive);
}
