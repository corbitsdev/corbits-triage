import { and, eq, sql } from "drizzle-orm";
import type { DB } from "@intx/db";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";

const { credential, grant, role } = schema;

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

const ADMIN_APPROVE_MIGRATION = "admin-github-approve";

/**
 * Workspaces whose GitHub was set up before admins could approve get the grant once; each is marked done, so a grant the owner
 * removes later stays removed across restarts. GitHub setup still grants on every connect.
 */
export async function migrateAdminGithubGrants(db: DB["db"]): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS corbits_triage_tenant_migration (
      tenant_id text NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
      name text NOT NULL,
      done_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, name)
    )
  `);
  const apps = await db.select({ id: credential.id, tenantId: credential.tenantId }).from(credential).where(and(
    eq(credential.name, "github"),
    eq(credential.status, "active"),
    sql`NOT EXISTS (SELECT 1 FROM corbits_triage_tenant_migration m WHERE m.tenant_id = ${credential.tenantId} AND m.name = ${ADMIN_APPROVE_MIGRATION})`,
  ));
  for (const app of apps) {
    await db.transaction(async function grantAdmin(tx) {
      await grantAdminGithub(tx, app.tenantId, app.id, new Date());
      await tx.execute(sql`INSERT INTO corbits_triage_tenant_migration (tenant_id, name) VALUES (${app.tenantId}, ${ADMIN_APPROVE_MIGRATION}) ON CONFLICT DO NOTHING`);
    });
  }
}
