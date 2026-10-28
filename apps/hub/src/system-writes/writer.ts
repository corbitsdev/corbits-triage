// The hub's writes to Interchange's records act as one system principal per workspace holding stock's admin role,
// and stock's grant check passes before each one.
import { and, eq } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { createGrantStore, createPrincipalStore, schema, type DB, type PrincipalKeyStore } from "@intx/db";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import type { GrantStore } from "@intx/types/authz";
import type { Tx } from "../github/admin-github-grant.js";

/** The local part of the system principal the hub writes Interchange's records as; never a mail sender. */
export const SYSTEM_WRITER = "triage-hub";

/** An open transaction acting as a workspace's system writer; only `transaction` and `join` build one. */
export type WriteTx = {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly principalId: string;
  readonly grants: GrantStore;
};

export class SystemWriteDenied extends Error {
  constructor(tenantId: string, resource: string, action: string) {
    super(`The hub may not ${action} ${resource} in workspace ${tenantId}.`);
    this.name = "SystemWriteDenied";
  }
}

/**
 * Stock's grant store reads only through a top-level database, so the check takes its own pooled read while the
 * caller's transaction stays open. The system writer's grants are never written inside that transaction.
 */
export async function check(w: WriteTx, resource: string, action: string): Promise<void> {
  const result = await authorize(w.grants, w.principalId, w.tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY });
  if (result.effect !== "allow") throw new SystemWriteDenied(w.tenantId, resource, action);
}

export type SystemWrites = ReturnType<typeof createSystemWrites>;

export function createSystemWrites({ db, principalKeyStore }: { db: DB["db"]; principalKeyStore: PrincipalKeyStore }) {
  const principals = createPrincipalStore(db, principalKeyStore);
  const grants = createGrantStore(db);
  // The writer keeps its principal for the life of the process; taking admin away later refuses its writes.
  const writers = new Map<string, string>();

  /** Mints the workspace's system writer and gives it stock's admin role, as stock tenant creation seats its owner. */
  async function place(tenantId: string): Promise<string> {
    const { principal, principalRole, role } = schema;
    return db.transaction(async function placeWriter(tx) {
      const [admin] = await tx.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
      if (!admin) throw new Error(`Workspace ${tenantId} has no system admin role.`);
      const created = await principals.createIfAbsent({ id: generateId("principal"), tenantId, kind: "user", refId: SYSTEM_WRITER, status: "active" }, tx);
      const [found] = created ? [created] : await tx.select({ id: principal.id }).from(principal).where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "user"), eq(principal.refId, SYSTEM_WRITER)));
      if (!found) throw new Error(`No ${SYSTEM_WRITER} principal in workspace ${tenantId}.`);
      await tx.insert(principalRole).values({ principalId: found.id, roleId: admin.id }).onConflictDoNothing();
      return found.id;
    });
  }

  async function writerOf(tenantId: string): Promise<string> {
    const cached = writers.get(tenantId);
    if (cached !== undefined) return cached;
    const principalId = await place(tenantId);
    writers.set(tenantId, principalId);
    return principalId;
  }

  return {
    async transaction<T>(tenantId: string, body: (w: WriteTx) => Promise<T>): Promise<T> {
      const principalId = await writerOf(tenantId);
      return db.transaction(function write(tx) {
        return body({ tx, tenantId, principalId, grants });
      });
    },
    async join(tx: Tx, tenantId: string): Promise<WriteTx> {
      return { tx, tenantId, principalId: await writerOf(tenantId), grants };
    },
  };
}
