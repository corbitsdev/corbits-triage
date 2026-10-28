import { schema, type DB } from "@intx/db";
import { and, inArray, notInArray } from "drizzle-orm";
import type { LocalProcessSidecarProvisioner } from "./local-provisioner.js";

export async function bootLocalSidecars(db: DB["db"], local: LocalProcessSidecarProvisioner): Promise<void> {
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
  await local.boot({ stillOpen });
}
