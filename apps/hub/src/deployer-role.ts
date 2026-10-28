// Each deployment does what its source asset's creator may, so the system principal that publishes the listener's chain
// holds this role, and no one else.
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { DEPLOYER_GRANTS, DEPLOYER_ROLE, TRIAGE_ROLE } from "@corbits/triage-contracts";
import { allowRole } from "./github/admin-github-grant.js";
import { SETS_ROLE_GRANTS } from "./system-writes/tenant.js";
import { check, type WriteTx } from "./system-writes/writer.js";

/** The tenant's Deployer role holding exactly its grants, created when missing; grants it held before are dropped. */
export async function ensureDeployerRole(w: WriteTx, stamp: Date): Promise<string> {
  for (const wanted of SETS_ROLE_GRANTS) check(w, wanted);
  const { tx, tenantId } = w;
  const { grant, role } = schema;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${DEPLOYER_ROLE}`}))`);
  const [found] = await tx.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, DEPLOYER_ROLE), eq(role.isSystem, true)));
  const id = found?.id ?? generateId("role");
  if (!found) await tx.insert(role).values({ id, tenantId, name: DEPLOYER_ROLE, description: "Publishes and deploys Triage's workflows", isSystem: true, createdAt: stamp, updatedAt: stamp });
  for (const { resource, action } of DEPLOYER_GRANTS) await allowRole(tx, tenantId, id, resource, action, stamp);
  const held = await tx.select({ id: grant.id, resource: grant.resource, action: grant.action, effect: grant.effect }).from(grant).where(and(eq(grant.tenantId, tenantId), eq(grant.roleId, id)));
  const extra = held.filter((row) => row.effect !== "allow" || !DEPLOYER_GRANTS.some((wanted) => wanted.resource === row.resource && wanted.action === row.action));
  if (extra.length > 0) await tx.delete(grant).where(inArray(grant.id, extra.map((row) => row.id)));
  return id;
}

/** The workspaces connected to a host, which hold Triage's role from then on. */
export async function triageTenants(db: DB["db"]): Promise<string[]> {
  const { role } = schema;
  const rows = await db.select({ tenantId: role.tenantId }).from(role).where(and(eq(role.name, TRIAGE_ROLE), eq(role.isSystem, true)));
  return rows.map((row) => row.tenantId);
}

/**
 * Only the workspace's system publisher holds the role: the portal once handed it to people, and their deployments
 * would act under it. Taken once the publisher's listener runs, so a workspace is never left with no one to deploy.
 */
export async function revokeHumanDeployers(db: DB["db"], tenantId: string, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const { principal, principalRole, role, user } = schema;
  const held = await db
    .select({ principalId: principalRole.principalId, roleId: role.id })
    .from(principalRole)
    .innerJoin(role, eq(role.id, principalRole.roleId))
    .innerJoin(principal, eq(principal.id, principalRole.principalId))
    .innerJoin(user, eq(user.id, principal.refId))
    .where(and(eq(role.tenantId, tenantId), eq(role.name, DEPLOYER_ROLE), eq(role.isSystem, true), eq(principal.kind, "user")));
  for (const row of held) {
    await db.delete(principalRole).where(and(eq(principalRole.principalId, row.principalId), eq(principalRole.roleId, row.roleId)));
  }
  if (held.length > 0) log({ level: "info", msg: "deployer_role_revoked", tenantId, people: held.length });
}
