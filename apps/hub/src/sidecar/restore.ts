import { schema, type DB } from "@intx/db";
import { and, eq, isNull } from "drizzle-orm";
import type { DriverProvisioner } from "./driver-provisioner.js";
import type { LocalProcessDriver } from "./local-driver.js";
import type { LocalSidecarManifest } from "./manifest-store.js";

export async function restoreLocalSidecars(
  db: DB["db"],
  driver: LocalProcessDriver,
  seam: DriverProvisioner,
  credentialEncryptionKey: string,
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
  await driver.restore(seam, isLocalSidecarLive, credentialEncryptionKey);
}
