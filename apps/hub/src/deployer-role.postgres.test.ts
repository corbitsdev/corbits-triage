// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { DEPLOYER_GRANTS } from "@corbits/triage-contracts";
import { ensureDeployerRole, revokeHumanDeployers } from "./deployer-role.js";

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
    await db.insert(schema.user).values(["usr_admin", "usr_member"].map((id) => ({ id, email: `${id}@deployer.test`, name: id })));
    await db.insert(schema.principal).values([
      { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "usr_admin", status: "active" },
      { id: "prn_member", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" },
      { id: "prn_publisher", tenantId: TENANT, kind: "user", refId: "triage-publisher", status: "active" },
    ]);
    const roleId = await db.transaction((tx) => ensureDeployerRole(tx, TENANT, new Date()));
    await db.insert(schema.grant).values({ id: "grt_old_publish", tenantId: TENANT, roleId, resource: "asset:*", action: "create", effect: "allow", origin: "role" });
    expect(await db.transaction((tx) => ensureDeployerRole(tx, TENANT, new Date()))).toBe(roleId);
    const held = await db.select({ resource: schema.grant.resource, action: schema.grant.action }).from(schema.grant).where(eq(schema.grant.roleId, roleId));
    expect(held.sort(byGrant)).toEqual(DEPLOYER_GRANTS.map(({ resource, action }) => ({ resource, action })).sort(byGrant));
    await db.insert(schema.principalRole).values(["prn_admin", "prn_member", "prn_publisher"].map((principalId) => ({ principalId, roleId })));

    const logged: Array<Record<string, unknown>> = [];
    await revokeHumanDeployers(db, TENANT, (entry) => logged.push(entry));

    expect(await db.select({ principalId: schema.principalRole.principalId }).from(schema.principalRole)).toEqual([{ principalId: "prn_publisher" }]);
    expect(logged).toEqual([{ level: "info", msg: "deployer_role_revoked", tenantId: TENANT, people: 2 }]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
