// Run with: bun run test:postgres
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore, runMigrations, schema, type DB } from "@intx/db";
import { DEPLOYER_ROLE } from "@corbits/triage-contracts";
import { setUpPublisher } from "../workflow-release/publisher.js";
import { assignRole, ASSIGNS_ROLE, keepDeploymentsAlive, managesTenant } from "./tenant.js";
import { createSystemWrites, SYSTEM_WRITER, SystemWriteDenied } from "./writer.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const KEEP_DEPLOYED = { lifecycle: { maxLifetime: "36500d" } };

async function withDatabase(body: (db: DB["db"]) => Promise<void>, max?: number): Promise<void> {
  const database = `corbits_writer_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database, ...(max !== undefined && { max }) };
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

function writesOn(db: DB["db"]) {
  return createSystemWrites({ db, principalKeyStore: createPrincipalKeyStore({ db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)) }) });
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

test("PostgreSQL: each workspace's system writer is minted once under a race, with one key, holding only stock's admin role", async () => {
  await withDatabase(async function minted(db) {
    const one = await workspace(db, "one");
    const two = await workspace(db, "two");
    const processes = [writesOn(db), writesOn(db)];
    await Promise.all(processes.flatMap((writes) => [one, one, two].map((tenantId) => writes.transaction(tenantId, [managesTenant(tenantId)], (w) => keepDeploymentsAlive(w, new Date())))));

    const [writerOne, ...extraOne] = await writersOf(db, one);
    const [writerTwo, ...extraTwo] = await writersOf(db, two);
    expect(extraOne).toEqual([]);
    expect(extraTwo).toEqual([]);
    expect(writerOne!.id).not.toBe(writerTwo!.id);
    expect(await rolesOf(db, writerOne!.id)).toEqual(["rol_one_admin"]);
    expect(await rolesOf(db, writerTwo!.id)).toEqual(["rol_two_admin"]);
    const keys = await db.select({ id: schema.principalKey.id }).from(schema.principalKey).where(eq(schema.principalKey.principalId, writerOne!.id));
    expect(keys).toHaveLength(1);
    expect((await configOf(db, one))?.config).toEqual(KEEP_DEPLOYED);
  });
}, 60_000);

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

test("PostgreSQL: a write its transaction did not declare throws and changes nothing", async () => {
  await withDatabase(async function undeclared(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "undeclared");
    const before = await configOf(db, tenantId);
    await expect(writes.transaction(tenantId, [], (w) => assignRole(w, "prn_undeclared_person", "rol_undeclared_reviewer"))).rejects.toThrow("not declared");
    await expect(writes.transaction(tenantId, [], (w) => keepDeploymentsAlive(w, new Date()))).rejects.toThrow("not declared");
    expect(await rolesOf(db, "prn_undeclared_person")).toEqual([]);
    expect(await configOf(db, tenantId)).toEqual(before);
  });
}, 60_000);

test("PostgreSQL: setting up the publisher again, or repeating its writes, changes nothing", async () => {
  await withDatabase(async function retried(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "retry");
    await setUpPublisher(writes, tenantId, "prn_retry_person", new Date("2026-10-01T00:00:00Z"));
    const first = await configOf(db, tenantId);
    const [deployer] = await db.select({ id: schema.role.id }).from(schema.role).where(and(eq(schema.role.tenantId, tenantId), eq(schema.role.name, DEPLOYER_ROLE)));

    await setUpPublisher(writes, tenantId, "prn_retry_person", new Date("2026-10-02T00:00:00Z"));
    await writes.transaction(tenantId, [ASSIGNS_ROLE, managesTenant(tenantId)], async function retry(w) {
      await assignRole(w, "prn_retry_person", deployer!.id);
      await keepDeploymentsAlive(w, new Date("2026-10-03T00:00:00Z"));
    });

    expect(await configOf(db, tenantId)).toEqual(first);
    expect(first?.config).toEqual(KEEP_DEPLOYED);
    expect(await rolesOf(db, "prn_retry_person")).toEqual([deployer!.id]);
  });
}, 60_000);

test("PostgreSQL: more writes at once than the pool has connections all finish, since no transaction waits on a check", async () => {
  await withDatabase(async function crowded(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "crowd");
    const people = Array.from({ length: 6 }, (_, index) => `prn_crowd_${index}`);
    await db.insert(schema.principal).values(people.map((id) => ({ id, tenantId, kind: "user" as const, refId: id, status: "active" as const })));
    await Promise.all(people.map((id) => writes.transaction(tenantId, [ASSIGNS_ROLE, managesTenant(tenantId)], async function crowdWrite(w) {
      await assignRole(w, id, "rol_crowd_reviewer");
      await keepDeploymentsAlive(w, new Date());
    })));
    for (const id of people) expect(await rolesOf(db, id)).toEqual(["rol_crowd_reviewer"]);
  }, 2);
}, 60_000);
