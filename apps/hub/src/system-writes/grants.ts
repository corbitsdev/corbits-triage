import { and, eq, sql } from "drizzle-orm";
import { schema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import type { Tx } from "../github/admin-github-grant.js";
import { CREATES_GRANT } from "./tenant.js";
import { check, type WriteTx } from "./writer.js";

const { grant } = schema;

type Holder = { roleId: string; principalId: null; origin: "role" } | { roleId: null; principalId: string; origin: "creator" };

/** Stock's grant table has no unique index to insert against, so two writers of one holder take turns to look. */
export async function lockHolder(tx: Tx, tenantId: string, holderId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${tenantId}:${holderId}`}))`);
}

export async function allow(tx: Tx, tenantId: string, holder: Holder, resource: string, action: string, stamp: Date): Promise<void> {
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

/** Grants a principal directly, with the creator origin stock gives a creator's grants; once, however often it is asked. */
export async function allowCreator(w: WriteTx, principalId: string, resource: string, action: string, stamp: Date): Promise<void> {
  check(w, CREATES_GRANT);
  await allow(w.tx, w.tenantId, { roleId: null, principalId, origin: "creator" }, resource, action, stamp);
}
