// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { migrateRepoEnabledFlag } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };

test("PostgreSQL: boot renames classificationAuthorized to enabled once", async () => {
  const testSchema = `corbits_repo_flag_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await db.insert(schema.tenant).values({
      id: "tnt_flag",
      name: "Flag",
      slug: "flag",
      domain: "flag.test",
      config: {
        other: { keep: true },
        corbitsTriage: {
          rev: 4,
          repos: [
            { name: "acme/off", connected: true, classificationAuthorized: false },
            { name: "acme/on", connected: true, classificationAuthorized: true },
            { name: "acme/new", connected: true, enabled: false },
          ],
        },
      },
    });

    await migrateRepoEnabledFlag(db);
    await migrateRepoEnabledFlag(db);

    const [row] = await db.select().from(schema.tenant).where(eq(schema.tenant.id, "tnt_flag"));
    expect(row?.config).toEqual({
      other: { keep: true },
      corbitsTriage: {
        rev: 5,
        repos: [
          { name: "acme/off", connected: true, enabled: false },
          { name: "acme/on", connected: true, enabled: true },
          { name: "acme/new", connected: true, enabled: false },
        ],
      },
    });
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
});
