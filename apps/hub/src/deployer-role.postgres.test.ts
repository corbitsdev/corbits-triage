// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createDB, createGrantStore, runMigrations, schema } from "@intx/db";
import { DEPLOYER_ROLE, MANAGER_RESULT_ACTION, MANAGER_RESULT_RESOURCE, MANAGER_STATE_ACTION, MANAGER_STATE_RESOURCE, TRIAGE_ROLE } from "@corbits/triage-contracts";
import { ensureDeployerRole, ensureDeployerRoles } from "./deployer-role.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_deployer";

/** What publishing creates, pushes and deploys, and every creator-sourced grant the listener, manager and code review declare. */
const PUBLISH_AND_CHAIN = [
  ["asset:*", "create"],
  ["asset:ast_mine", "write"],
  ["workflow:*", "create"],
  ["asset:ast_manager", "read"],
  [MANAGER_STATE_RESOURCE, MANAGER_STATE_ACTION],
  [MANAGER_RESULT_RESOURCE, MANAGER_RESULT_ACTION],
  ["workflow-run:run_manager", "manage"],
  ["workflow-run:run_manager", "read"],
] as const;

test("PostgreSQL: an admin publishes and deploys the chain only once given the Deployer role, pushing only to assets it granted itself, and every connected workspace gets the role once", async () => {
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
    await db.insert(schema.principal).values(["admin", "deployer"].map((name) => ({ id: `prn_${name}`, tenantId: TENANT, kind: "user" as const, refId: `usr_${name}`, status: "active" as const })));
    await db.insert(schema.role).values([
      { id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true },
      { id: "rol_triage", tenantId: TENANT, name: TRIAGE_ROLE, isSystem: true },
    ]);
    await db.insert(schema.grant).values(["read", "create", "manage"].map((action) => ({ id: `grt_admin_${action}`, tenantId: TENANT, roleId: "rol_admin", resource: "*", action, effect: "allow" as const, origin: "system" as const })));

    const stamp = new Date();
    const [first, second] = await Promise.all([1, 2].map(function ensure() {
      return db.transaction((tx) => ensureDeployerRole(tx, TENANT, stamp));
    }));
    expect(second).toBe(first);
    await ensureDeployerRoles(db, () => stamp, function ignore() {});
    expect(await db.select({ id: schema.role.id }).from(schema.role).where(eq(schema.role.name, DEPLOYER_ROLE))).toEqual([{ id: first! }]);
    await db.insert(schema.principalRole).values([{ principalId: "prn_admin", roleId: "rol_admin" }, { principalId: "prn_deployer", roleId: "rol_admin" }, { principalId: "prn_deployer", roleId: first! }]);

    // What the portal's publish grants its publisher on each asset it creates.
    await db.insert(schema.grant).values(["admin", "deployer"].map((name) => ({ id: `grt_${name}_push`, tenantId: TENANT, principalId: `prn_${name}`, resource: "asset:ast_mine", action: "write", effect: "allow" as const, origin: "creator" as const })));
    const grants = createGrantStore(db);
    async function allowed(principalId: string): Promise<boolean[]> {
      return Promise.all(PUBLISH_AND_CHAIN.map(async function may([resource, action]) {
        return (await authorize(grants, principalId, TENANT, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
      }));
    }
    expect(await allowed("prn_deployer")).toEqual([true, true, true, true, true, true, true, true]);
    expect(await allowed("prn_admin")).toEqual([true, true, true, true, false, true, true, true]);
    expect((await authorize(grants, "prn_deployer", TENANT, "asset:ast_theirs", "write", { conditions: HUB_CONDITION_REGISTRY })).effect).not.toBe("allow");
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
