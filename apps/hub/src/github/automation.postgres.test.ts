// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { TRIAGE_ROLE } from "@corbits/triage-contracts";
import { holdDos, type SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { createAutomation } from "./automation.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_automation";
const REPO = "acme/api";

test("PostgreSQL: a Do runs unattended only while the pr-triage role holds its kind's grant", async () => {
  const database = `corbits_automation_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Automation", slug: "automation", domain: "automation.test" });
    const automation = createAutomation({ db, now: () => new Date() });
    async function held(): Promise<boolean> {
      const suggested: SuggestedDo = { list: "pass", index: 0, kind: "labels", reason: "", effectId: "e-labels", target: { labels: ["api"] } };
      const [step] = holdDos([suggested], await automation.automaticKinds(TENANT, REPO));
      return (step as SuggestedDo).held === true;
    }

    expect(await held()).toBe(true);
    const [role] = await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT));
    expect(role).toEqual(expect.objectContaining({ name: TRIAGE_ROLE, isSystem: true }));
    await db.insert(schema.grant).values({ id: "grt_triage_labels", tenantId: TENANT, roleId: role!.id, resource: "triage-do:labels:*", action: "invoke", effect: "allow", origin: "role" });
    expect(await held()).toBe(false);
    await db.delete(schema.grant).where(eq(schema.grant.roleId, role!.id));
    expect(await held()).toBe(true);
    expect(await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT))).toHaveLength(1);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
