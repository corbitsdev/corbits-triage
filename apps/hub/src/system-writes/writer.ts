// The hub's writes to Interchange's records act as one system principal per workspace holding stock's admin role,
// and stock's grant check passes before each one.
import { and, eq } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { createGrantStore, createPrincipalStore, schema, type DB, type PrincipalKeyStore } from "@intx/db";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { generateId } from "@intx/hub-common";
import type { Tx } from "../github/admin-github-grant.js";

/** The refId of the system principal the hub writes Interchange's records as. */
export const SYSTEM_WRITER = "triage-hub";

/** A resource and action stock's own route checks before the write. */
export type Check = { readonly resource: string; readonly action: string };

/** An open transaction acting as a workspace's system writer, cleared for the checks it declared. */
export type WriteTx = {
  readonly tx: Tx;
  readonly tenantId: string;
  readonly principalId: string;
  readonly cleared: ReadonlySet<string>;
};

function keyOf({ resource, action }: Check): string {
  return `${action} ${resource}`;
}

export class SystemWriteDenied extends Error {
  constructor(tenantId: string, resource: string, action: string) {
    super(`The hub may not ${action} ${resource} in workspace ${tenantId}.`);
    this.name = "SystemWriteDenied";
  }
}

/** Every write names its check; one its transaction did not declare up front is a defect in the caller. */
export function check(w: WriteTx, wanted: Check): void {
  if (!w.cleared.has(keyOf(wanted))) throw new Error(`The hub's write of ${wanted.action} ${wanted.resource} was not declared before its transaction.`);
}

/** Runs stock's grant check inside the transaction, so a grant changed before the check is read as it now stands. */
export async function authorizeWrite(w: WriteTx, { resource, action }: Check): Promise<void> {
  // Stock's grant store reads only through `query`, which a transaction has; its type asks for the top-level client.
  const grants = createGrantStore(w.tx as unknown as DB["db"]);
  const result = await authorize(grants, w.principalId, w.tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY });
  if (result.effect !== "allow") throw new SystemWriteDenied(w.tenantId, resource, action);
}

export type SystemWrites = ReturnType<typeof createSystemWrites>;

export function createSystemWrites({ db, principalKeyStore }: { db: DB["db"]; principalKeyStore: PrincipalKeyStore }) {
  const principals = createPrincipalStore(db, principalKeyStore);
  const writers = new Map<string, Promise<string>>();

  /**
   * Mints the workspace's system writer holding stock's admin role, as stock tenant creation seats its owner; only once,
   * so admin taken away stays away. Stock's store mints every principal a key, and only a `user` principal resolves as a
   * mail sender, so the writer is an `agent`.
   */
  async function place(tenantId: string): Promise<string> {
    const { principal, principalRole, role } = schema;
    return db.transaction(async function placeWriter(tx) {
      const [admin] = await tx.select({ id: role.id }).from(role).where(and(eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)));
      if (!admin) throw new Error(`Workspace ${tenantId} has no system admin role.`);
      const created = await principals.createIfAbsent({ id: generateId("principal"), tenantId, kind: "agent", refId: SYSTEM_WRITER, status: "active" }, tx);
      if (created) {
        await tx.insert(principalRole).values({ principalId: created.id, roleId: admin.id });
        return created.id;
      }
      const [found] = await tx.select({ id: principal.id }).from(principal).where(and(eq(principal.tenantId, tenantId), eq(principal.kind, "agent"), eq(principal.refId, SYSTEM_WRITER)));
      if (!found) throw new Error(`No ${SYSTEM_WRITER} principal in workspace ${tenantId}.`);
      return found.id;
    });
  }

  /** Concurrent first writes to a workspace share one mint, so they do not each hold a connection contending for it. */
  async function writerOf(tenantId: string): Promise<string> {
    const known = writers.get(tenantId);
    if (known !== undefined) return known;
    const minting = place(tenantId);
    writers.set(tenantId, minting);
    try {
      return await minting;
    } catch (error) {
      writers.delete(tenantId);
      throw error;
    }
  }

  /** Holds the writer's admin seat for the transaction, so admin taken away while it runs still stops the writes. */
  async function holdAdmin(tx: Tx, tenantId: string, principalId: string): Promise<void> {
    const { principalRole, role } = schema;
    const [held] = await tx.select({ roleId: principalRole.roleId })
      .from(principalRole)
      .innerJoin(role, eq(role.id, principalRole.roleId))
      .where(and(eq(principalRole.principalId, principalId), eq(role.tenantId, tenantId), eq(role.name, "admin"), eq(role.isSystem, true)))
      .for("share", { of: principalRole });
    if (!held) throw new SystemWriteDenied(tenantId, "Interchange's records", "write");
  }

  return {
    async transaction<T>(tenantId: string, checks: readonly Check[], body: (w: WriteTx) => Promise<T>): Promise<T> {
      const principalId = await writerOf(tenantId);
      return db.transaction(async function write(tx) {
        await holdAdmin(tx, tenantId, principalId);
        const w: WriteTx = { tx, tenantId, principalId, cleared: new Set(checks.map(keyOf)) };
        for (const wanted of checks) await authorizeWrite(w, wanted);
        return body(w);
      });
    },
  };
}
