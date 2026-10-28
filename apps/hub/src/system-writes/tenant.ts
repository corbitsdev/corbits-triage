import { and, eq } from "drizzle-orm";
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

const CREATES_ROLE: Check = { resource: "role:*", action: "create" };

const CREATES_GRANT: Check = { resource: "grant:*", action: "create" };

/** Stock checks `manage` on each `grant:<id>` it deletes; the ids are unknown before the transaction, so the wildcard is declared. */
const MANAGES_GRANTS: Check = { resource: "grant:*", action: "manage" };

export const SETS_ROLE_GRANTS: readonly Check[] = [CREATES_ROLE, CREATES_GRANT, MANAGES_GRANTS];

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
  const { principal, role } = schema;
  const [held] = await w.tx.select({ id: principal.id }).from(principal).where(and(eq(principal.id, principalId), eq(principal.tenantId, w.tenantId)));
  const [given] = await w.tx.select({ id: role.id }).from(role).where(and(eq(role.id, roleId), eq(role.tenantId, w.tenantId)));
  if (!held || !given) throw new Error(`Principal ${principalId} and role ${roleId} must both belong to workspace ${w.tenantId}.`);
  await w.tx.insert(schema.principalRole).values({ principalId, roleId }).onConflictDoNothing();
}
