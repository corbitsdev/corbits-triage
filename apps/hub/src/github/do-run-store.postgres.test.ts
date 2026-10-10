// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { createDoRunStore, migrateDoRuns, type DoClaim } from "./do-run-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const CLAIM: DoClaim = {
  tenantId: "tnt_dos", effectId: "e1", runId: "run_1", repo: "acme/widgets", number: 8, headSha: "abc",
  actionId: "a", branch: "always", index: 0, kind: "labels", source: "portal", principalId: null,
};

test("PostgreSQL: one claim per Do effect; a failed or expired claim is taken again", async () => {
  const testSchema = `corbits_dos_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateDoRuns(db);
    await db.insert(schema.tenant).values({ id: "tnt_dos", name: "Dos", slug: "dos", domain: "dos.test" });
    const store = createDoRunStore(db);

    const [first, second] = await Promise.all([store.claim(CLAIM), store.claim(CLAIM)]);
    const winner = first ?? second;
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await store.read("tnt_dos", "e1"))?.status).toBe("running");
    await store.settle(winner!, { status: "done", result: { labels: ["api"] } });
    expect(await store.claim(CLAIM)).toBeUndefined();
    expect(await store.read("tnt_dos", "e1")).toMatchObject({ status: "done", attempts: 1, result: { labels: ["api"] } });

    const failing = await store.claim({ ...CLAIM, effectId: "e2" });
    await store.fail(failing!, "github POST -> 422");
    const retried = await store.claim({ ...CLAIM, effectId: "e2" });
    expect(retried).toMatchObject({ status: "running", attempts: 2, error: null });
    expect(await store.settle(failing!, { status: "done", result: null })).toBeUndefined();

    const stale = await store.claim({ ...CLAIM, effectId: "e3" });
    expect(await store.claim({ ...CLAIM, effectId: "e3" })).toBeUndefined();
    await db.execute(sql`UPDATE corbits_triage_do_run SET updated_at = now() - interval '3 minutes' WHERE effect_id = 'e3'`);
    expect(await store.claim({ ...CLAIM, effectId: "e3" })).toMatchObject({ status: "running", attempts: 2 });
    expect(await store.settle(stale!, { status: "done", result: null })).toBeUndefined();

    expect((await store.list("tnt_dos", { repo: "acme/widgets", number: 8 })).map((row) => row.effectId).sort()).toEqual(["e1", "e2", "e3"]);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
