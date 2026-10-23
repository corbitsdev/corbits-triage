// Which Do kinds triage writes unattended on a repository is decided by the grants of the tenant's pr-triage system
// role, evaluated by stock authz.
import { and, eq, sql } from "drizzle-orm";
import { evaluateGrants } from "@intx/authz";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/types/authz";
import { ACTION_KINDS, DO_GRANT_ACTION, doResource, hostKinds, TRIAGE_ROLE, type ActionKind, type RepoSource } from "@corbits/triage-contracts";
import { allowRole, type Tx } from "./admin-github-grant.js";

export type AutomationDeps = { db: DB["db"]; now: () => Date };

/** What triage writes unattended on a repository from the moment it is enabled. */
const ENABLED_KINDS: readonly ActionKind[] = ["comment", "labels"];

async function findRole(db: DB["db"] | Tx, tenantId: string): Promise<string | undefined> {
  const { role } = schema;
  const [found] = await db.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, TRIAGE_ROLE), eq(role.isSystem, true)));
  return found?.id;
}

/** The tenant's pr-triage role, created when missing, so a new workspace can grant it before its first run. */
export async function ensureTriageRole(tx: Tx, tenantId: string, stamp: Date): Promise<string> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${TRIAGE_ROLE}`}))`);
  const found = await findRole(tx, tenantId);
  if (found) return found;
  const id = generateId("role");
  await tx.insert(schema.role).values({ id, tenantId, name: TRIAGE_ROLE, description: "What triage does on its own", isSystem: true, createdAt: stamp, updatedAt: stamp });
  return id;
}

export async function grantEnabledKinds(tx: Tx, tenantId: string, repo: string, source: RepoSource, stamp: Date): Promise<void> {
  const roleId = await ensureTriageRole(tx, tenantId, stamp);
  for (const kind of hostKinds(source).filter((held) => ENABLED_KINDS.includes(held))) await allowRole(tx, tenantId, roleId, doResource(kind, repo), DO_GRANT_ACTION, stamp);
}

export function createAutomation(deps: AutomationDeps) {
  async function automaticKinds(tenantId: string, repo: string): Promise<ActionKind[]> {
    const roleId = (await findRole(deps.db, tenantId)) ?? (await deps.db.transaction((tx) => ensureTriageRole(tx, tenantId, deps.now())));
    const rows = await deps.db.select().from(schema.grant).where(and(eq(schema.grant.tenantId, tenantId), eq(schema.grant.roleId, roleId)));
    const grants = rows.map((row): GrantRule => ({ ...row, conditions: row.conditions as GrantRule["conditions"] }));
    const kinds: ActionKind[] = [];
    for (const kind of ACTION_KINDS) {
      if ((await evaluateGrants(grants, doResource(kind, repo), DO_GRANT_ACTION)).effect === "allow") kinds.push(kind);
    }
    return kinds;
  }

  return { automaticKinds };
}
