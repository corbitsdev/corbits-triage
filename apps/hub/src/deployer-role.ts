// Each deployment does what its source asset's creator may, so whoever publishes the listener's chain holds this role.
import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { DEPLOYER_GRANTS, DEPLOYER_ROLE, TRIAGE_ROLE } from "@corbits/triage-contracts";
import { allowRole, type Tx } from "./github/admin-github-grant.js";

/** The tenant's Deployer role and its grants, created when missing. */
export async function ensureDeployerRole(tx: Tx, tenantId: string, stamp: Date): Promise<string> {
  const { role } = schema;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${DEPLOYER_ROLE}`}))`);
  const [found] = await tx.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, DEPLOYER_ROLE), eq(role.isSystem, true)));
  const id = found?.id ?? generateId("role");
  if (!found) await tx.insert(role).values({ id, tenantId, name: DEPLOYER_ROLE, description: "Publishes and deploys Triage's workflows", isSystem: true, createdAt: stamp, updatedAt: stamp });
  for (const { resource, action } of DEPLOYER_GRANTS) await allowRole(tx, tenantId, id, resource, action, stamp);
  return id;
}

/** Workspaces connected to a host before the role existed get it at the next migrate. */
export async function ensureDeployerRoles(db: DB["db"], now: () => Date, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const { role } = schema;
  const tenants = await db.select({ tenantId: role.tenantId }).from(role).where(and(eq(role.name, TRIAGE_ROLE), eq(role.isSystem, true)));
  for (const { tenantId } of tenants) {
    await db.transaction(function ensure(tx) {
      return ensureDeployerRole(tx, tenantId, now());
    });
  }
  log({ level: "info", msg: "deployer_roles_ensured", tenants: tenants.length });
}
