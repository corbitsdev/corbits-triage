import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";

const { grant, role } = schema;

type Tx = Parameters<Parameters<DB["db"]["transaction"]>[0]>[0];

/** Approving a pull request is a grant of its own, `approve` on `github-review:<owner>/<name>`; the admin role holds it on `github-review:*`. */
export const APPROVE_ACTION = "approve";
const ANY_REVIEW_RESOURCE = "github-review:*";

/** GitHub repository names are case-insensitive, and so are the grants on them. */
export function reviewResource(repo: string): string {
  return `github-review:${repo.toLowerCase()}`;
}

async function allowRole(tx: Tx, tenantId: string, roleId: string, resource: string, action: string, stamp: Date): Promise<void> {
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

/** Admins act on GitHub: the hub's GitHub routes check `use` on the App credential and `approve` on reviews, which stock admin lacks. Owners hold every grant. */
export async function grantAdminGithub(tx: Tx, tenantId: string, credentialId: string, stamp: Date): Promise<void> {
  const [admin] = await tx.select({ id: role.id }).from(role)
    .where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
  if (!admin) return;
  await allowRole(tx, tenantId, admin.id, `credential:${credentialId}`, "use", stamp);
  await allowRole(tx, tenantId, admin.id, ANY_REVIEW_RESOURCE, APPROVE_ACTION, stamp);
}

