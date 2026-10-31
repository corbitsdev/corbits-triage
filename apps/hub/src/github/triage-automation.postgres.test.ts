// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { createDB, createGrantStore, runMigrations, schema } from "@intx/db";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { doResource, TRIAGE_ROLE } from "@corbits/triage-contracts";
import { connectTriage, createAutomation } from "./automation.js";
import { createTriageAutomation } from "./triage-automation.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_triage_automation";
const REPO = "acme/api";

test("PostgreSQL: allowing a kind needs grant create, an enabled repository of the source and a kind the host writes that the policy names and its verdict does not always hold, and gives the pr-triage role one grant however often it is asked", async () => {
  const database = `corbits_triage_automation_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({
      id: TENANT, name: "Automation", slug: "automation", domain: "automation.test",
      config: { corbitsTriage: { repos: [
        { name: REPO, connected: true, enabled: true, installationId: 7 },
        { name: "acme/off", connected: true, enabled: false, installationId: 7 },
        { name: "PROJ/web", source: "bitbucket-datacenter", connected: true, enabled: true },
      ] } },
    });
    await db.insert(schema.principal).values([
      { id: "prn_admin", tenantId: TENANT, kind: "user", refId: "usr_admin", status: "active" },
      { id: "prn_member", tenantId: TENANT, kind: "user", refId: "usr_member", status: "active" },
    ]);
    await db.insert(schema.role).values({ id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true });
    await db.insert(schema.principalRole).values({ principalId: "prn_admin", roleId: "rol_admin" });
    await db.insert(schema.grant).values({ id: "grt_admin_create", tenantId: TENANT, roleId: "rol_admin", resource: "*", action: "create", effect: "allow", origin: "system" });
    await db.transaction((tx) => connectTriage(tx, TENANT, [], new Date()));
    const grants = createGrantStore(db);
    const allowAutomation = createTriageAutomation({
      db,
      async authorize(principalId, tenantId, resource, action) {
        return (await authorize(grants, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
      },
      automaticKinds: createAutomation({ db }).automaticKinds,
      async wantedKinds() {
        return ["comment", "labels", "request-review", "merge"];
      },
      now: () => new Date(),
      log() {},
    });
    async function allow(principalId: string, body: Parameters<typeof allowAutomation>[0]) {
      const res = await allowAutomation(body, { tenantId: TENANT, principalId });
      return { status: res.status, body: await res.json() };
    }
    const [triage] = await db.select().from(schema.role).where(eq(schema.role.name, TRIAGE_ROLE));
    async function triageGrants() {
      return db.select({ resource: schema.grant.resource, action: schema.grant.action }).from(schema.grant).where(eq(schema.grant.roleId, triage!.id));
    }

    expect(await allow("prn_member", { repo: REPO, source: "github", kind: "request-review", list: "pass" })).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    expect(await allow("prn_admin", { repo: "acme/off", source: "github", kind: "request-review", list: "pass" })).toMatchObject({ status: 409, body: { error: { code: "repo_not_enabled" } } });
    expect(await allow("prn_admin", { repo: REPO, source: "bitbucket-datacenter", kind: "request-review", list: "pass" })).toMatchObject({ status: 409, body: { error: { code: "repo_not_enabled" } } });
    expect(await allow("prn_admin", { repo: "PROJ/web", source: "bitbucket-datacenter", kind: "labels", list: "pass" })).toMatchObject({ status: 422, body: { error: { code: "kind_not_on_host" } } });
    expect(await allow("prn_admin", { repo: REPO, source: "github", kind: "merge", list: "fail" })).toMatchObject({ status: 422, body: { error: { code: "always_held" } } });
    expect(await allow("prn_admin", { repo: REPO, source: "github", kind: "close", list: "fail" })).toMatchObject({ status: 422, body: { error: { code: "kind_not_wanted" } } });
    expect(await triageGrants()).toEqual([]);

    const answers = await Promise.all([1, 2, 3].map(() => allow("prn_admin", { repo: REPO, source: "github", kind: "request-review", list: "pass" })));
    expect(answers).toEqual([1, 2, 3].map(() => ({ status: 200, body: { automatic: ["request-review"] } })));
    expect(await triageGrants()).toEqual([{ resource: doResource("request-review", "github", REPO), action: "invoke" }]);
    expect(await db.select().from(schema.grant).where(eq(schema.grant.principalId, "prn_admin"))).toEqual([]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
