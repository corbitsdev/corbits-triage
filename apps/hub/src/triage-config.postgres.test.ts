// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { triageNs } from "./github/tenant-config.js";
import { createTriageConfig } from "./triage-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const T = "tnt_cfg";
const ORIGIN = "https://portal.test";

test("PostgreSQL: of two settings saves from the same revision one gets 409, and re-applied to the stored settings both changes survive", async () => {
  const database = `corbits_cfg_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let a: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    a = createDB(config);
    const db = a.db;
    await a.db.insert(schema.tenant).values({ id: T, name: "C", slug: "c", domain: "c.test", config: { other: 1, corbitsTriage: { rev: 2, repos: [] } } });
    await a.db.insert(schema.principal).values({ id: "prn_admin", tenantId: T, kind: "user", refId: "usr_admin", status: "active" });
    const save = createTriageConfig({
      db: a.db,
      cipher: undefined as never,
      getSession: async () => ({ user: { id: "usr_admin" } }),
      authorize: async () => true,
      trustedPortalOrigins: [ORIGIN],
    });
    async function put(body: unknown) {
      const res = await save(new Request(`https://hub.test/api/integrations/triage-config/${T}`, {
        method: "PUT",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify(body),
      }), T);
      return res.status;
    }
    async function stored() {
      const [row] = await db.select().from(schema.tenant).where(eq(schema.tenant.id, T));
      return row!.config;
    }

    const [first, second] = await Promise.all([
      put({ rev: 2, config: { repos: [], labelMap: { bug: "triage:bug" } } }),
      put({ rev: 2, config: { repos: [], allowlist: { "acme/one": ["ada"] } } }),
    ]);
    expect([first, second].sort()).toEqual([200, 409]);
    const change = first === 409 ? { labelMap: { bug: "triage:bug" } } : { allowlist: { "acme/one": ["ada"] } };

    const fresh = triageNs(await stored());
    expect(fresh.rev).toBe(3);
    expect(await put({ rev: fresh.rev, config: { ...fresh, ...change } })).toBe(200);
    expect(await stored()).toMatchObject({ other: 1 });
    expect(triageNs(await stored())).toEqual({ rev: 4, repos: [], labelMap: { bug: "triage:bug" }, allowlist: { "acme/one": ["ada"] } });
  } finally {
    await a?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
