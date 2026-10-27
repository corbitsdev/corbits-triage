import { schema, type DB } from "@intx/db";
import { createSidecarCredentialResolver } from "@intx/hub-sessions";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
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
  async function stillOpen(allocationIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (allocationIds.length === 0) return new Set();
    const ids = [...allocationIds];
    const allocations = await db
      .select({ id: schema.sidecarAllocation.id })
      .from(schema.sidecarAllocation)
      .where(and(inArray(schema.sidecarAllocation.id, ids), notInArray(schema.sidecarAllocation.status, ["released", "failed"])));
    const probes = await db
      .select({ id: schema.workflowProbe.id })
      .from(schema.workflowProbe)
      .where(and(inArray(schema.workflowProbe.id, ids), notInArray(schema.workflowProbe.status, ["succeeded", "failed"])));
    return new Set([...allocations, ...probes].map((row) => row.id));
  }
  async function pastEnsuring(): Promise<{ allocationId: string; generation: number }[]> {
    const allocations = await db
      .select({ allocationId: schema.sidecarAllocation.id, generation: schema.sidecarAllocation.generation })
      .from(schema.sidecarAllocation)
      .where(and(eq(schema.sidecarAllocation.provisionerId, local.provisioner.id), inArray(schema.sidecarAllocation.status, ["released", "failed"])));
    const probes = await db
      .select({ allocationId: schema.workflowProbe.id, generation: schema.workflowProbe.generation })
      .from(schema.workflowProbe)
      .where(and(eq(schema.workflowProbe.provisionerId, local.provisioner.id), inArray(schema.workflowProbe.status, ["succeeded", "failed"])));
    return [...allocations, ...probes];
  }
  await local.restore({ isLive, hasWork, stillOpen, pastEnsuring });
}
