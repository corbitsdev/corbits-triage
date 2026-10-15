// Requires PostgreSQL at TEST_DB. The hub's start reads every tenant, so the test gets a database of its own.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { TRIAGE_ROLE } from "@corbits/triage-contracts";
import { holdDos, type SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { createAutomation } from "./automation.js";
import { triageNs } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_automation";
const AUTOMATED = "acme/api";
const MANUAL = "acme/web";
const NESTED = "acme/docs";
const BITBUCKET = "TRI/widgets";

test("PostgreSQL: a Do runs unattended only while the pr-triage role holds its kind's grant; an automated repository's posting carries over once; a Bitbucket repository loses the kinds its host lacks", async () => {
  const database = `corbits_automation_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    const repos = [
      { name: AUTOMATED, connected: true, enabled: true, cleanupMode: "automated" },
      { name: MANUAL, connected: true, enabled: true, cleanupMode: "human-approved" },
      { name: NESTED, connected: true, policy: { enabled: true, cleanupMode: "automated" } },
      { name: BITBUCKET, source: "bitbucket-datacenter", connected: true, enabled: true },
    ];
    await db.insert(schema.tenant).values([
      { id: TENANT, name: "Automation", slug: "automation", domain: "automation.test", config: { corbitsTriage: { repos } } },
      { id: "tnt_new", name: "New", slug: "new", domain: "new.test" },
    ]);
    const automation = createAutomation({ db, now: () => new Date() });
    const targets = { comment: { body: "hi" }, labels: { labels: ["api"] } };
    async function held(repo: string, kind: keyof typeof targets): Promise<boolean> {
      const suggested: SuggestedDo = { list: "pass", index: 0, kind, reason: "", effectId: `e-${kind}`, target: targets[kind] };
      const [step] = holdDos([suggested], await automation.automaticKinds(TENANT, repo));
      return (step as SuggestedDo).held === true;
    }
    async function grants() {
      return db.select({ resource: schema.grant.resource }).from(schema.grant).where(eq(schema.grant.tenantId, TENANT));
    }

    await automation.startUp();
    expect((await grants()).map((row) => row.resource).sort()).toEqual([`triage-do:comment:${NESTED}`, `triage-do:comment:${AUTOMATED}`, `triage-do:labels:${NESTED}`, `triage-do:labels:${AUTOMATED}`].sort());
    expect(await db.select().from(schema.role).where(eq(schema.role.tenantId, "tnt_new"))).toEqual([expect.objectContaining({ name: TRIAGE_ROLE, isSystem: true })]);
    const [tenant] = await db.select({ config: schema.tenant.config }).from(schema.tenant).where(eq(schema.tenant.id, TENANT));
    expect(JSON.stringify(triageNs(tenant!.config).repos)).not.toContain("cleanupMode");
    expect(await held(AUTOMATED, "comment")).toBe(false);
    expect(await held(MANUAL, "comment")).toBe(true);

    const [role] = await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT));
    expect(role?.isSystem).toBe(true);
    await db.insert(schema.grant).values({ id: "grt_triage_labels", tenantId: TENANT, roleId: role!.id, resource: "triage-do:labels:*", action: "invoke", effect: "allow", origin: "role" });
    expect(await held(MANUAL, "labels")).toBe(false);

    await db.delete(schema.grant).where(eq(schema.grant.roleId, role!.id));
    await automation.startUp();
    expect(await grants()).toEqual([]);
    expect(await held(AUTOMATED, "comment")).toBe(true);
    expect(await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT))).toHaveLength(1);

    const kept = [`triage-do:comment:${BITBUCKET.toLowerCase()}`, `triage-do:labels:${AUTOMATED}`];
    await db.insert(schema.grant).values([...kept, `triage-do:labels:${BITBUCKET.toLowerCase()}`].map((resource, i) => ({ id: `grt_held_${i}`, tenantId: TENANT, roleId: role!.id, resource, action: "invoke", effect: "allow" as const, origin: "role" as const })));
    await automation.startUp();
    await automation.startUp();
    expect((await grants()).map((row) => row.resource).sort()).toEqual(kept.sort());
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
