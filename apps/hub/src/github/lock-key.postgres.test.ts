import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { findOrVersionArtifact, runArtifactMigrations } from "@corbits/artifacts";
import { triageStateName, type PrTriageRow } from "@corbits/triage-contracts";
import { createTriageStateStore, TriageStateConflictError } from "./triage-state-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_state";
const row: PrTriageRow = { number: 1, headSha: "abc", status: "queued", attempts: 0, firstSeenAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z" };

test("store first write and findOrVersionArtifact never both create", async () => {
  const database = `corbits_lockkey_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  const a = createDB(config);
  const b = createDB(config);
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    await a.db.insert(schema.tenant).values({ id: TENANT, name: "S", slug: "s", domain: "s.test" });
    await a.db.insert(schema.principal).values({ id: "prn_github", tenantId: TENANT, kind: "user", refId: "github", status: "active" });
    const store = createTriageStateStore({ db: a.db, writerFor: async () => "prn_github", log: () => {} });
    const title = triageStateName("acme/r0");
    // Hold the package's lock key in one session; a store first write that shares it must block.
    let settledWhileHeld = false;
    let storeErr: unknown;
    let write: Promise<void> | undefined;
    await b.db.transaction(async function packageWrite(tx) {
      await findOrVersionArtifact(tx as never, { scope: { tenantId: TENANT, principalId: "prn_github" }, ownerPrincipalId: null, kind: "document", title, content: "{}", source: {} });
      write = store.save(TENANT, "acme/r0", [row], null).then(() => { settledWhileHeld = true; }, (e) => { storeErr = e; settledWhileHeld = true; });
      await new Promise((r) => setTimeout(r, 1500));
    });
    const heldUntilCommit = !settledWhileHeld;
    await write;
    const dupes = await a.db.execute(sql.raw("select title, count(*)::int as n from artifacts.artifact group by title"));
    expect(heldUntilCommit).toBe(true);
    expect(storeErr).toBeInstanceOf(TriageStateConflictError);
    expect([...dupes].every((d: any) => d.n === 1)).toBe(true);
  } finally {
    await a.close();
    await b.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 60_000);
