// Run with: bun run test:postgres
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore, runMigrations, schema, type DB, type PrincipalKeyStore } from "@intx/db";
import { assignRole, ASSIGNS_ROLE, keepDeploymentsAlive, managesTenant, unassignRole } from "./tenant.js";
import { createSystemWrites, SYSTEM_WRITER, SystemWriteDenied } from "./writer.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };

async function withDatabase(body: (db: DB["db"]) => Promise<void>): Promise<void> {
  const database = `corbits_writer_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await body(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

function keysOn(db: DB["db"]): PrincipalKeyStore {
  return createPrincipalKeyStore({ db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)) });
}

function writesOn(db: DB["db"]) {
  return createSystemWrites({ db, principalKeyStore: keysOn(db) });
}

/** A workspace as stock tenant creation leaves it: a system admin role holding `* read`, `* create` and `* manage`. */
async function workspace(db: DB["db"], name: string): Promise<string> {
  const tenantId = `tnt_${name}`;
  await db.insert(schema.tenant).values({ id: tenantId, name, slug: name, domain: `${name}.test`, config: {} });
  await db.insert(schema.role).values([
    { id: `rol_${name}_admin`, tenantId, name: "admin", isSystem: true },
    { id: `rol_${name}_reviewer`, tenantId, name: "reviewer" },
  ]);
  await db.insert(schema.grant).values(["read", "create", "manage"].map((action) => ({ id: `grt_${name}_${action}`, tenantId, roleId: `rol_${name}_admin`, resource: "*", action, effect: "allow" as const, origin: "system" as const })));
  await db.insert(schema.principal).values({ id: `prn_${name}_person`, tenantId, kind: "user", refId: `usr_${name}`, status: "active" });
  return tenantId;
}

async function writersOf(db: DB["db"], tenantId: string) {
  return db.select({ id: schema.principal.id }).from(schema.principal).where(and(eq(schema.principal.tenantId, tenantId), eq(schema.principal.refId, SYSTEM_WRITER)));
}

async function rolesOf(db: DB["db"], principalId: string): Promise<string[]> {
  const rows = await db.select({ roleId: schema.principalRole.roleId }).from(schema.principalRole).where(eq(schema.principalRole.principalId, principalId));
  return rows.map((row) => row.roleId);
}

async function configOf(db: DB["db"], tenantId: string) {
  const [row] = await db.select({ config: schema.tenant.config, updatedAt: schema.tenant.updatedAt }).from(schema.tenant).where(eq(schema.tenant.id, tenantId));
  return row;
}

test("PostgreSQL: the writer's writes land while it holds admin, and once admin is taken away nothing is written, even after a restart", async () => {
  await withDatabase(async function refused(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "held");
    await writes.transaction(tenantId, [ASSIGNS_ROLE], (w) => assignRole(w, "prn_held_person", "rol_held_reviewer"));
    expect(await rolesOf(db, "prn_held_person")).toEqual(["rol_held_reviewer"]);

    const [writer] = await writersOf(db, tenantId);
    await db.delete(schema.principalRole).where(eq(schema.principalRole.principalId, writer!.id));
    const before = await configOf(db, tenantId);
    await expect(writes.transaction(tenantId, [ASSIGNS_ROLE], (w) => assignRole(w, "prn_held_person", "rol_held_admin"))).rejects.toThrow(SystemWriteDenied);
    await expect(writes.transaction(tenantId, [managesTenant(tenantId)], (w) => keepDeploymentsAlive(w, new Date()))).rejects.toThrow(SystemWriteDenied);
    expect(await rolesOf(db, "prn_held_person")).toEqual(["rol_held_reviewer"]);
    expect(await configOf(db, tenantId)).toEqual(before);
    const restarted = writesOn(db);
    await expect(restarted.transaction(tenantId, [ASSIGNS_ROLE], (w) => assignRole(w, "prn_held_person", "rol_held_admin"))).rejects.toThrow(SystemWriteDenied);
    expect(await rolesOf(db, writer!.id)).toEqual([]);

    const bare = "tnt_bare";
    await db.insert(schema.tenant).values({ id: bare, name: "bare", slug: "bare", domain: "bare.test", config: {} });
    await expect(writes.transaction(bare, [managesTenant(bare)], (w) => keepDeploymentsAlive(w, new Date()))).rejects.toThrow("no system admin role");
    expect(await writersOf(db, bare)).toEqual([]);
  });
}, 60_000);

test("PostgreSQL: a role is assigned or taken only when the principal and the role are both in the transaction's workspace", async () => {
  await withDatabase(async function scoped(db) {
    const writes = writesOn(db);
    const home = await workspace(db, "home");
    await workspace(db, "away");
    await expect(writes.transaction(home, [ASSIGNS_ROLE], (w) => assignRole(w, "prn_away_person", "rol_home_reviewer"))).rejects.toThrow("must both belong");
    await expect(writes.transaction(home, [ASSIGNS_ROLE], (w) => assignRole(w, "prn_home_person", "rol_away_reviewer"))).rejects.toThrow("must both belong");
    expect(await rolesOf(db, "prn_away_person")).toEqual([]);
    expect(await rolesOf(db, "prn_home_person")).toEqual([]);
    await db.insert(schema.principalRole).values({ principalId: "prn_away_person", roleId: "rol_away_reviewer" });
    await expect(writes.transaction(home, [ASSIGNS_ROLE], (w) => unassignRole(w, "prn_away_person", "rol_away_reviewer"))).rejects.toThrow("must both belong");
    expect(await rolesOf(db, "prn_away_person")).toEqual(["rol_away_reviewer"]);
  });
}, 60_000);
