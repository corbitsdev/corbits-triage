import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { ANY_DO_RESOURCE, DO_GRANT_ACTION } from "@corbits/triage-contracts";
import { allow } from "../system-writes/grants.js";

const { role } = schema;

export type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

export async function allowRole(tx: Tx, tenantId: string, roleId: string, resource: string, action: string, stamp: Date): Promise<void> {
  await allow(tx, tenantId, { roleId, principalId: null, origin: "role" }, resource, action, stamp);
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
