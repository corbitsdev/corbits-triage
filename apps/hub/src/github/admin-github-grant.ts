import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { ANY_DO_RESOURCE, DO_GRANT_ACTION } from "@corbits/triage-contracts";

const { grant, role } = schema;

export type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

type Holder = { roleId: string; principalId: null; origin: "role" } | { roleId: null; principalId: string; origin: "creator" };

/** Stock's grant table has no unique index to insert against, so two writers of one holder take turns to look. */
export async function lockHolder(tx: Tx, tenantId: string, holderId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${holderId}`}))`);
}

async function allow(tx: Tx, tenantId: string, holder: Holder, resource: string, action: string, stamp: Date): Promise<void> {
  await lockHolder(tx, tenantId, holder.roleId === null ? holder.principalId : holder.roleId);
  const target = holder.roleId === null ? eq(grant.principalId, holder.principalId) : eq(grant.roleId, holder.roleId);
  const [held] = await tx.select({ id: grant.id }).from(grant).where(and(
    eq(grant.tenantId, tenantId),
    target,
    eq(grant.resource, resource),
    eq(grant.action, action),
    eq(grant.effect, "allow"),
  ));
  if (held) return;
  await tx.insert(grant).values({
    id: generateId("grant"), tenantId, ...holder, resource, action,
    effect: "allow", conditions: null, expiresAt: null, createdAt: stamp, updatedAt: stamp,
  });
}

export async function allowRole(tx: Tx, tenantId: string, roleId: string, resource: string, action: string, stamp: Date): Promise<void> {
  await allow(tx, tenantId, { roleId, principalId: null, origin: "role" }, resource, action, stamp);
}

export async function allowCreator(tx: Tx, tenantId: string, principalId: string, resource: string, action: string, stamp: Date): Promise<void> {
  await allow(tx, tenantId, { roleId: null, principalId, origin: "creator" }, resource, action, stamp);
}

async function adminRoleId(tx: Tx, tenantId: string): Promise<string | undefined> {
  const [admin] = await tx.select({ id: role.id }).from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
  return admin?.id;
}

/** Admins act on a host: the hub's routes check `use` on its credentials and each Do kind's grant, which stock admin lacks. Owners hold every grant. */
export async function grantAdminHost(tx: Tx, tenantId: string, credentialIds: readonly string[], stamp: Date): Promise<void> {
  const admin = await adminRoleId(tx, tenantId);
  if (!admin) return;
  for (const id of credentialIds) await allowRole(tx, tenantId, admin, `credential:${id}`, "use", stamp);
  await allowRole(tx, tenantId, admin, ANY_DO_RESOURCE, DO_GRANT_ACTION, stamp);
}
