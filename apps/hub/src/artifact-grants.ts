// Stock admins hold read, create and manage on everything but not write, so without these grants only owners could
// version an artifact. Each new artifact is writable and archivable by its creator and the admin role; owners hold
// every grant already.
import { type } from "arktype";
import { sql } from "drizzle-orm";
import type { ArtifactRow, ArtifactTx, ResolvedPrincipal } from "@corbits/artifacts";
import { schema, type DB } from "@intx/db";
import { CHECK_PACK_TITLE_PREFIX, WORKSPACE_POLICY_TITLE_PREFIX } from "@corbits/triage-contracts";
import { adminRoleId, allowCreator, allowRole } from "./github/admin-github-grant.js";

const WRITER_ACTIONS = ["write", "archive"] as const;

const MissingGrants = type({ id: "string", tenantId: "string", roleId: "string", action: type.enumerated(...WRITER_ACTIONS) }).array();

export function createArtifactGrants(now: () => Date) {
  return async function grantArtifactWriters(tx: ArtifactTx, row: ArtifactRow, scope: ResolvedPrincipal): Promise<void> {
    const resource = `artifact:${row.id}`;
    const admin = await adminRoleId(tx, scope.tenantId);
    for (const action of WRITER_ACTIONS) {
      await allowCreator(tx, scope.tenantId, scope.principalId, resource, action, now());
      if (admin) await allowRole(tx, scope.tenantId, admin, resource, action, now());
    }
  };
}

/**
 * Gives the admin role the writes on policies made before these grants existed. One query finds what is missing, which
 * after the first migrate is nothing. It reads `artifacts.artifact` directly because `listArtifacts` lists one tenant.
 */
export async function grantAdminsPolicyWrites(db: DB["db"], now: () => Date, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const { grant, role } = schema;
  const missing = MissingGrants.assert(await db.execute(sql`
    select a.id, a.tenant_id as "tenantId", r.id as "roleId", w.action
    from artifacts.artifact a
    join ${role} r on r.tenant_id = a.tenant_id and r.name = 'admin' and r.is_system
    cross join (values ('write'), ('archive')) as w(action)
    where (a.title like ${`${CHECK_PACK_TITLE_PREFIX}%`} or a.title like ${`${WORKSPACE_POLICY_TITLE_PREFIX}%`})
      and not exists (
        select 1 from ${grant} g
        where g.role_id = r.id and g.resource = 'artifact:' || a.id and g.action = w.action and g.effect = 'allow'
      )
  `));
  if (missing.length === 0) return;
  await db.transaction(async function grantMissing(tx) {
    for (const { id, tenantId, roleId, action } of missing) await allowRole(tx, tenantId, roleId, `artifact:${id}`, action, now());
  });
  log({ level: "info", msg: "policy_grants_backfilled", grants: missing.length });
}
