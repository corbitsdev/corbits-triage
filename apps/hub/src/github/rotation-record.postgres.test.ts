// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { claimRotation, clearRotation, prepareCorbitsTriagePatch, rotationRecord, triageNs } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const T = "tnt_rot";

function patchReq(ns: Record<string, unknown>) {
  return new Request("https://hub/api/tenants/x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { corbitsTriage: ns } }) });
}

test("PostgreSQL: a rotation is claimed once, a portal save read before it is refused and one read after keeps it, and only the matching record is cleared", async () => {
  const database = `corbits_rot_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let a: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    a = createDB(config);
    await a.db.insert(schema.tenant).values({ id: T, name: "R", slug: "r", domain: "r.test", config: { corbitsTriage: { repos: [], rev: 3 } } });
    const stale = { repos: [], rev: 3 };
    const record = { from: "run_a", to: "run_c", at: "2026-10-08T00:00:00.000Z" };
    expect(await claimRotation(a.db, T, record)).toBe(true);
    expect(await claimRotation(a.db, T, { ...record, to: "run_d" })).toBe(false);
    const refused = await prepareCorbitsTriagePatch(a.db, T, patchReq(stale));
    expect(refused instanceof Response && refused.status).toBe(409);
    const [row] = await a.db.select().from(schema.tenant).where(eq(schema.tenant.id, T));
    const fresh = triageNs(row!.config);
    const passed = await prepareCorbitsTriagePatch(a.db, T, patchReq({ ...fresh, confidenceFloor: 0.5 }));
    expect(passed instanceof Response).toBe(false);
    expect(rotationRecord(JSON.parse(await (passed as Request).text()).config.corbitsTriage)).toEqual(record);
    await clearRotation(a.db, T, { ...record, to: "other" });
    const [kept] = await a.db.select().from(schema.tenant).where(eq(schema.tenant.id, T));
    expect(rotationRecord(triageNs(kept!.config))).toEqual(record);
    await clearRotation(a.db, T, record);
    const [cleared] = await a.db.select().from(schema.tenant).where(eq(schema.tenant.id, T));
    expect(rotationRecord(triageNs(cleared!.config))).toBeUndefined();
    // Only the claim and the matching clear wrote; the refused claim and the other clear were no-ops.
    expect(triageNs(cleared!.config).rev).toBe(5);
  } finally {
    await a?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
