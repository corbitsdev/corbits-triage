import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import { type } from "arktype";
import { lifecycleDurationMs, LifecycleDuration } from "@intx/types";
import { asRecord } from "@corbits/common";
import { check, type Check, type WriteTx } from "./writer.js";

/** The longest lifetime Interchange accepts, so a deployment lives until a newer one replaces it. */
const KEEP_DEPLOYED_LIFETIME = "36500d";

function keepsDeployed(lifetime: unknown): boolean {
  const parsed = LifecycleDuration(lifetime);
  return !(parsed instanceof type.errors) && lifecycleDurationMs(parsed) >= lifecycleDurationMs(KEEP_DEPLOYED_LIFETIME);
}

export function managesTenant(tenantId: string): Check {
  return { resource: `tenant:${tenantId}`, action: "manage" };
}

export const ASSIGNS_ROLE: Check = { resource: "role:*", action: "manage" };

/** Raises the workspace's deployment lifetime ceiling so each deployment lives until a newer one replaces it. */
export async function keepDeploymentsAlive(w: WriteTx, stamp: Date): Promise<void> {
  check(w, managesTenant(w.tenantId));
  const { tenant } = schema;
  const [row] = await w.tx.select({ config: tenant.config }).from(tenant).where(eq(tenant.id, w.tenantId)).for("update");
  if (!row) throw new Error(`Workspace ${w.tenantId} not found.`);
  const config = asRecord(row.config) ?? {};
  const lifecycle = asRecord(config["lifecycle"]) ?? {};
  if (keepsDeployed(lifecycle["maxLifetime"])) return;
  await w.tx.update(tenant)
    .set({ config: { ...config, lifecycle: { ...lifecycle, maxLifetime: KEEP_DEPLOYED_LIFETIME } }, updatedAt: stamp })
    .where(eq(tenant.id, w.tenantId));
}

export async function assignRole(w: WriteTx, principalId: string, roleId: string): Promise<void> {
  check(w, ASSIGNS_ROLE);
  await w.tx.insert(schema.principalRole).values({ principalId, roleId }).onConflictDoNothing();
}
