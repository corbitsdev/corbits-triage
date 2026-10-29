// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, createPrincipalKeyStore, runMigrations, schema } from "@intx/db";
import { DEPLOYER_GRANTS } from "@corbits/triage-contracts";
import { ensureDeployerRole, revokeHumanDeployers } from "./deployer-role.js";
import { SETS_ROLE_GRANTS } from "./system-writes/tenant.js";
import { createSystemWrites } from "./system-writes/writer.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_deployer";

function byGrant(a: { resource: string; action: string }, b: { resource: string; action: string }): number {
  return `${a.resource} ${a.action}`.localeCompare(`${b.resource} ${b.action}`);
}

test("PostgreSQL: the Deployer role holds exactly its grants, and only the workspace's publisher keeps it", async () => {
  const database = `corbits_deployer_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Deployer", slug: "deployer", domain: "deployer.test" });
    await db.insert(schema.role).values({ id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true });
    await db.insert(schema.grant).values(["create", "manage"].map((action) => ({ id: `grt_admin_${action}`, tenantId: TENANT, roleId: "rol_admin", resource: "*", action, effect: "allow" as const, origin: "system" as const })));
    const writes = createSystemWrites({ db, principalKeyStore: createPrincipalKeyStore({ db, cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)) }) });
    await db.insert(schema.user).values(["usr_admin", "usr_member"].map((id) => ({ id, email: `${id}@deployer.test`, name: id })));
    await db.insert(schema.principal).values([
      { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "usr_admin", status: "active" },
      { id: "prn_member", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" },
      { id: "prn_publisher", tenantId: TENANT, kind: "user", refId: "triage-publisher", status: "active" },
    ]);
    const roleId = await writes.transaction(TENANT, SETS_ROLE_GRANTS, (w) => ensureDeployerRole(w, new Date()));
    await db.insert(schema.grant).values({ id: "grt_old_publish", tenantId: TENANT, roleId, resource: "asset:*", action: "create", effect: "allow", origin: "role" });
    expect(await writes.transaction(TENANT, SETS_ROLE_GRANTS, (w) => ensureDeployerRole(w, new Date()))).toBe(roleId);
    const held = await db.select({ resource: schema.grant.resource, action: schema.grant.action }).from(schema.grant).where(eq(schema.grant.roleId, roleId));
    expect(held.sort(byGrant)).toEqual(DEPLOYER_GRANTS.map(({ resource, action }) => ({ resource, action })).sort(byGrant));
    const people = ["prn_admin", "prn_member", "prn_publisher"];
    await db.insert(schema.principalRole).values(people.map((principalId) => ({ principalId, roleId })));

    const logged: Array<Record<string, unknown>> = [];
    await revokeHumanDeployers(writes, TENANT, (entry) => logged.push(entry));

    expect(await db.select({ principalId: schema.principalRole.principalId }).from(schema.principalRole).where(inArray(schema.principalRole.principalId, people))).toEqual([{ principalId: "prn_publisher" }]);
    expect(logged).toEqual([{ level: "info", msg: "deployer_role_revoked", tenantId: TENANT, people: 2 }]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
