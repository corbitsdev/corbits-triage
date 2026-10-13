// Which Do kinds triage writes unattended on a repository is decided by the grants of the tenant's pr-triage system
// role, evaluated by stock authz.
import { and, eq, sql } from "drizzle-orm";
import { asRecord } from "@corbits/common";
import { evaluateGrants } from "@intx/authz";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { GrantRule } from "@intx/types/authz";
import { ACTION_KINDS, DO_GRANT_ACTION, doResource, TRIAGE_ROLE, type ActionKind } from "@corbits/triage-contracts";
import { allowRole, type Tx } from "./admin-github-grant.js";
import { patchCorbitsTriage, repoRecords, type CorbitsTriageNs, type RepoRecord } from "./tenant-config.js";

export type AutomationDeps = { db: DB["db"]; now: () => Date };

/** What a repository set to post automatically wrote unattended before grants decided it. */
const POSTED_KINDS: readonly ActionKind[] = ["comment", "labels"];

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

/** A record's stored posting mode, at the top level or under `policy` as `repoPolicy` reads it. */
function postingMode(record: Record<string, unknown>): unknown {
  return record.cleanupMode ?? asRecord(record.policy)?.cleanupMode;
}

function stripPostingMode(record: Record<string, unknown>): Record<string, unknown> {
  const { cleanupMode: _cleanupMode, ...rest } = record;
  const policy = asRecord(rest.policy);
  if (!policy) return rest;
  const { cleanupMode: _nested, ...nested } = policy;
  return { ...rest, policy: nested };
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

  /**
   * Creates the role, and turns each repository's stored posting mode into grants: an automated one's role is granted
   * comment and labels on it. The mode is then dropped from the record, in the same transaction, so this runs once.
   */
  function carryPostingMode(tenantId: string) {
    return async function carry(ns: CorbitsTriageNs, tx: Tx): Promise<CorbitsTriageNs | undefined> {
      const roleId = await ensureTriageRole(tx, tenantId, deps.now());
      const records = repoRecords(ns) as Array<RepoRecord & Record<string, unknown>>;
      if (records.every((record) => postingMode(record) === undefined)) return undefined;
      for (const record of records) {
        if (postingMode(record) !== "automated") continue;
        for (const kind of POSTED_KINDS) await allowRole(tx, tenantId, roleId, doResource(kind, record.name), DO_GRANT_ACTION, deps.now());
      }
      return { ...ns, repos: ns.repos?.map((row) => (records.includes(row) ? (stripPostingMode(row) as RepoRecord) : row)) };
    };
  }

  async function startUp(): Promise<void> {
    const tenants = await deps.db.select({ id: schema.tenant.id }).from(schema.tenant);
    for (const tenant of tenants) await patchCorbitsTriage(deps.db, tenant.id, carryPostingMode(tenant.id));
  }

  return { automaticKinds, startUp };
}
