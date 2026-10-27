// Which Do kinds triage writes unattended on a repository is decided by the grants of the tenant's pr-triage system
// role, evaluated by stock authz.
import { and, eq, inArray, sql } from "drizzle-orm";
import { evaluateGrants } from "@intx/authz";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/types/authz";
import { ACTION_KINDS, DO_GRANT_ACTION, doResource, hostKinds, TRIAGE_ROLE, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { allowRole, grantAdminHost, type Tx } from "./admin-github-grant.js";

export type AutomationDeps = { db: DB["db"] };

/** What triage writes unattended on a repository from the moment it is enabled. */
const ENABLED_KINDS: readonly ActionKind[] = ["comment", "labels"];

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

export async function grantEnabledKinds(tx: Tx, tenantId: string, repo: string, source: RepoSource, stamp: Date): Promise<void> {
  const roleId = await triageRoleId(tx, tenantId);
  if (!roleId) throw new Error(`Workspace ${tenantId} has no ${TRIAGE_ROLE} role; connecting a host creates it.`);
  for (const kind of hostKinds(source).filter((held) => ENABLED_KINDS.includes(held))) await allowRole(tx, tenantId, roleId, doResource(kind, repo), DO_GRANT_ACTION, stamp);
}

/** Every kind the pr-triage role holds on the repository, so enabling it again starts from the enabled kinds. */
export async function revokeRepoKinds(tx: Tx, tenantId: string, repo: string): Promise<void> {
  const roleId = await triageRoleId(tx, tenantId);
  if (!roleId) return;
  const { grant } = schema;
  await tx.delete(grant).where(and(
    eq(grant.tenantId, tenantId),
    eq(grant.roleId, roleId),
    eq(grant.effect, "allow"),
    inArray(grant.resource, ACTION_KINDS.map((kind) => doResource(kind, repo))),
  ));
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
