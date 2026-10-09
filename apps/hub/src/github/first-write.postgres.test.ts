// Requires PostgreSQL at TEST_DB. Two processes writing a repository's
// first triage state at once must leave exactly one artifact.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { runArtifactMigrations } from "@corbits/artifacts";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { createTriageStateStore } from "./triage-state-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_state";
const ROUNDS = 40;

function row(number: number): PrTriageRow {
  return { number, headSha: "abc", status: "queued", attempts: 0, firstSeenAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z" };
}

test("PostgreSQL: two concurrent first writes from two processes leave exactly one artifact", async () => {
  const database = `corbits_first_write_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let a: ReturnType<typeof createDB> | undefined;
  let b: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    a = createDB(config);
    b = createDB(config);
    await a.db.insert(schema.tenant).values({ id: TENANT, name: "State", slug: "state", domain: "state.test" });
    await a.db.insert(schema.principal).values({ id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" });
    const sa = createTriageStateStore({ db: a.db, writerFor: async () => "prn_github", log: () => {} });
    const sb = createTriageStateStore({ db: b.db, writerFor: async () => "prn_github", log: () => {} });
    let bothSucceeded = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const repo = `acme/r${i}`;
      const results = await Promise.allSettled([sa.save(TENANT, repo, [row(1)], null), sb.save(TENANT, repo, [row(2)], null)]);
      if (results.every((result) => result.status === "fulfilled")) bothSucceeded++;
    }
    const dupes = await a.db.execute(sql.raw("select title, count(*)::int as n from artifacts.artifact group by title having count(*) > 1"));
    expect(bothSucceeded).toBe(0);
    expect([...dupes]).toEqual([]);
  } finally {
    await a?.close();
    await b?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
