import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";

const { grant, role } = schema;

type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

/** Admins act on GitHub: the hub's GitHub routes check `use` on the App credential, which stock admin lacks. */
export async function grantAdminGithubUse(tx: Tx, tenantId: string, credentialId: string, stamp: Date): Promise<void> {
  const [admin] = await tx.select({ id: role.id }).from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
  if (!admin) return;
  const resource = `credential:${credentialId}`;
  const [held] = await tx.select({ id: grant.id }).from(grant).where(and(
    eq(grant.tenantId, tenantId),
    eq(grant.roleId, admin.id),
    eq(grant.resource, resource),
    eq(grant.action, "use"),
    eq(grant.effect, "allow"),
  ));
  if (held) return;
  await tx.insert(grant).values({
    id: generateId("grant"), tenantId, roleId: admin.id, principalId: null, resource, action: "use",
    effect: "allow", conditions: null, origin: "role", expiresAt: null, createdAt: stamp, updatedAt: stamp,
  });
}
