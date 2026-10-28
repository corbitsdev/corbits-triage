// Run with: bun run test:postgres
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore, runMigrations, schema, type DB } from "@intx/db";
import { DEPLOYER_ROLE } from "@corbits/triage-contracts";
import { setUpPublisher } from "../workflow-release/publisher.js";
import { assignRole, keepDeploymentsAlive } from "./tenant.js";
import { createSystemWrites, SYSTEM_WRITER, SystemWriteDenied } from "./writer.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const KEEP_DEPLOYED = { lifecycle: { maxLifetime: "36500d" } };

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
    await Promise.all(processes.flatMap((writes) => [one, one, two].map((tenantId) => writes.transaction(tenantId, (w) => keepDeploymentsAlive(w, new Date())))));

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

test("PostgreSQL: the writer's writes land while it holds admin, and once admin is taken away nothing is written", async () => {
  await withDatabase(async function refused(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "held");
    await writes.transaction(tenantId, (w) => assignRole(w, "prn_held_person", "rol_held_reviewer"));
    expect(await rolesOf(db, "prn_held_person")).toEqual(["rol_held_reviewer"]);

    const [writer] = await writersOf(db, tenantId);
    await db.delete(schema.principalRole).where(eq(schema.principalRole.principalId, writer!.id));
    const before = await configOf(db, tenantId);
    await expect(writes.transaction(tenantId, (w) => assignRole(w, "prn_held_person", "rol_held_admin"))).rejects.toThrow(SystemWriteDenied);
    await expect(writes.transaction(tenantId, (w) => keepDeploymentsAlive(w, new Date()))).rejects.toThrow(SystemWriteDenied);
    expect(await rolesOf(db, "prn_held_person")).toEqual(["rol_held_reviewer"]);
    expect(await configOf(db, tenantId)).toEqual(before);

    const bare = "tnt_bare";
    await db.insert(schema.tenant).values({ id: bare, name: "bare", slug: "bare", domain: "bare.test", config: {} });
    await expect(writes.transaction(bare, (w) => keepDeploymentsAlive(w, new Date()))).rejects.toThrow("no system admin role");
    expect(await writersOf(db, bare)).toEqual([]);
  });
}, 60_000);

test("PostgreSQL: setting up the publisher again, alone or inside a caller's transaction, changes nothing", async () => {
  await withDatabase(async function retried(db) {
    const writes = writesOn(db);
    const tenantId = await workspace(db, "retry");
    await setUpPublisher(writes, tenantId, "prn_retry_person", new Date("2026-10-01T00:00:00Z"));
    const first = await configOf(db, tenantId);
    const [deployer] = await db.select({ id: schema.role.id }).from(schema.role).where(and(eq(schema.role.tenantId, tenantId), eq(schema.role.name, DEPLOYER_ROLE)));

    await setUpPublisher(writes, tenantId, "prn_retry_person", new Date("2026-10-02T00:00:00Z"));
    await db.transaction(async function callerTx(tx) {
      const w = await writes.join(tx, tenantId);
      await assignRole(w, "prn_retry_person", deployer!.id);
      await keepDeploymentsAlive(w, new Date("2026-10-03T00:00:00Z"));
    });

    expect(await configOf(db, tenantId)).toEqual(first);
    expect(first?.config).toEqual(KEEP_DEPLOYED);
    expect(await rolesOf(db, "prn_retry_person")).toEqual([deployer!.id]);
  });
}, 60_000);
