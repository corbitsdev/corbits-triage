// Which Do kinds triage writes unattended on a repository is decided by the grants of the tenant's pr-triage system
// role, evaluated by stock authz.
import { and, eq, inArray, sql } from "drizzle-orm";
import { evaluateGrants } from "@intx/authz";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/types/authz";
import { ACTION_KINDS, DO_GRANT_ACTION, doResource, hostKinds, postingKinds, TRIAGE_ROLE, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { allowRole, grantAdminHost, lockHolder, type Tx } from "./admin-github-grant.js";

export type AutomationDeps = { db: DB["db"] };

export async function triageRoleId(db: DB["db"] | Tx, tenantId: string): Promise<string | undefined> {
  const { role } = schema;
  const [found] = await db.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, TRIAGE_ROLE), eq(role.isSystem, true)));
  return found?.id;
}

async function ensureTriageRole(tx: Tx, tenantId: string, stamp: Date): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${TRIAGE_ROLE}`}))`);
  if (await triageRoleId(tx, tenantId)) return;
  await tx.insert(schema.role).values({ id: generateId("role"), tenantId, name: TRIAGE_ROLE, description: "What triage does on its own", isSystem: true, createdAt: stamp, updatedAt: stamp });
}

/**
 * Every connect of either host, not only the first: the pr-triage role exists before a repository can be enabled, and
 * admins hold the grants on `credentialIds` that the hub's routes check, whoever stored them.
 */
export async function connectTriage(tx: Tx, tenantId: string, credentialIds: readonly string[], stamp: Date): Promise<void> {
  await ensureTriageRole(tx, tenantId, stamp);
  await grantAdminHost(tx, tenantId, credentialIds, stamp);
}

async function requireTriageRole(tx: Tx, tenantId: string): Promise<string> {
  const roleId = await triageRoleId(tx, tenantId);
  if (!roleId) throw new Error(`Workspace ${tenantId} has no ${TRIAGE_ROLE} role; connecting a host creates it.`);
  return roleId;
}

function isAlways(): boolean {
  return true;
}

async function deleteKinds(tx: Tx, tenantId: string, roleId: string, repo: string, kinds: readonly ActionKind[]): Promise<void> {
  if (kinds.length === 0) return;
  const { grant } = schema;
  await tx.delete(grant).where(and(
    eq(grant.tenantId, tenantId),
    eq(grant.roleId, roleId),
    eq(grant.effect, "allow"),
    inArray(grant.resource, kinds.map((kind) => doResource(kind, repo))),
  ));
}

/**
 * The pr-triage role holds exactly `wanted` on the enabled repository, posting included: only missing kinds are
 * inserted and only the others deleted, so the same policy read again touches no row.
 */
export async function grantWanted(tx: Tx, tenantId: string, repo: string, source: RepoSource, wanted: readonly ActionKind[], stamp: Date, stillWanted: () => boolean = isAlways): Promise<void> {
  const roleId = await requireTriageRole(tx, tenantId);
  await lockHolder(tx, tenantId, roleId);
  // Checked under the role's lock, which every grant writer takes, so a read overtaken meanwhile writes nothing.
  if (!stillWanted()) return;
  const kinds = hostKinds(source).filter((kind) => wanted.includes(kind) || postingKinds(source).includes(kind));
  await deleteKinds(tx, tenantId, roleId, repo, ACTION_KINDS.filter((kind) => !kinds.includes(kind)));
  for (const kind of kinds) await allowRole(tx, tenantId, roleId, doResource(kind, repo), DO_GRANT_ACTION, stamp);
}

/**
 * Triage posts its verdict unattended on a repository from the moment it is enabled, and nothing else until a policy
 * read grants it: a grant left from before the repository was last switched off does not come back.
 */
export async function grantEnabledKinds(tx: Tx, tenantId: string, repo: string, source: RepoSource, stamp: Date): Promise<void> {
  await grantWanted(tx, tenantId, repo, source, [], stamp);
}

/** Every kind the pr-triage role holds on the repository, so enabling it again starts from the enabled kinds. */
export async function revokeRepoKinds(tx: Tx, tenantId: string, repo: string): Promise<void> {
  const roleId = await triageRoleId(tx, tenantId);
  if (roleId) await deleteKinds(tx, tenantId, roleId, repo, ACTION_KINDS);
}

export function createAutomation(deps: AutomationDeps) {
  async function automaticKinds(tenantId: string, repo: string): Promise<ActionKind[]> {
    const roleId = await triageRoleId(deps.db, tenantId);
    if (!roleId) return [];
    const rows = await deps.db.select().from(schema.grant).where(and(eq(schema.grant.tenantId, tenantId), eq(schema.grant.roleId, roleId)));
    const grants = rows.map((row): GrantRule => ({ ...row, conditions: row.conditions as GrantRule["conditions"] }));
    const kinds: ActionKind[] = [];
    for (const kind of ACTION_KINDS) {
      if ((await evaluateGrants(grants, doResource(kind, repo), DO_GRANT_ACTION, { conditions: "pessimistic" })).effect === "allow") kinds.push(kind);
    }
    return kinds;
  }

  return { automaticKinds };
}
