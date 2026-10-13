import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { ANY_DO_RESOURCE, DO_GRANT_ACTION } from "@corbits/triage-contracts";

const { grant, role } = schema;

export type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

export async function allowRole(tx: Tx, tenantId: string, roleId: string, resource: string, action: string, stamp: Date): Promise<void> {
  const [held] = await tx.select({ id: grant.id }).from(grant).where(and(
    eq(grant.tenantId, tenantId),
    eq(grant.roleId, roleId),
    eq(grant.resource, resource),
    eq(grant.action, action),
    eq(grant.effect, "allow"),
  ));
  if (held) return;
  await tx.insert(grant).values({
    id: generateId("grant"), tenantId, roleId, principalId: null, resource, action,
    effect: "allow", conditions: null, origin: "role", expiresAt: null, createdAt: stamp, updatedAt: stamp,
  });
}

/** Admins act on GitHub: the hub's GitHub routes check `use` on the App credential and each Do kind's grant, which stock admin lacks. Owners hold every grant. */
export async function grantAdminGithub(tx: Tx, tenantId: string, credentialId: string, stamp: Date): Promise<void> {
  const [admin] = await tx.select({ id: role.id }).from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
  if (!admin) return;
  await allowRole(tx, tenantId, admin.id, `credential:${credentialId}`, "use", stamp);
  await allowRole(tx, tenantId, admin.id, ANY_DO_RESOURCE, DO_GRANT_ACTION, stamp);
}
