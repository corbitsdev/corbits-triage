import { schema, type DB } from "@intx/db";
import { createSidecarCredentialResolver } from "@intx/hub-sessions";
import { and, eq, isNull } from "drizzle-orm";
import type { LocalProcessSidecarProvisioner } from "./local-provisioner.js";
import type { LocalSidecarHold } from "./manifest-store.js";

export async function restoreLocalSidecars(
  db: DB["db"],
  local: LocalProcessSidecarProvisioner,
): Promise<void> {
  const credentials = createSidecarCredentialResolver({ db });
  async function isLive(hold: LocalSidecarHold & { readonly sidecarId: string }): Promise<boolean> {
    const row = await db.query.sidecarAllocation.findFirst({
      columns: { id: true },
      where: and(
        eq(schema.sidecarAllocation.id, hold.allocationId),
        eq(schema.sidecarAllocation.provisionerId, local.provisioner.id),
        eq(schema.sidecarAllocation.status, "allocated"),
        eq(schema.sidecarAllocation.generation, hold.generation),
        eq(schema.sidecarAllocation.sidecarId, hold.sidecarId),
        isNull(schema.sidecarAllocation.initializationLeaseId),
      ),
    });
    return row !== undefined;
  }
  async function hasWork(sidecarId: string): Promise<boolean> {
    return (await credentials.resolveBindings(sidecarId)).length > 0;
  }
  await local.restore({ isLive, hasWork });
}
