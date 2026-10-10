// Requires PostgreSQL at TEST_DB. Artifact tables always live in the `artifacts`
// schema, so the test gets a database of its own instead of a schema.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { createArtifact, runArtifactMigrations } from "@corbits/artifacts";
import { triageStateName, type PrTriageRow } from "@corbits/triage-contracts";
import { createTriageStateStore } from "./triage-state-store.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const REPO = "acme/widgets";
const ROW: PrTriageRow = {
  number: 7,
  headSha: "abc",
  status: "triaged",
  runId: "run_7",
  attempts: 0,
  firstSeenAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
};

test("PostgreSQL: unreadable triage state loads as empty with a warning and the next save replaces it", async () => {
  const database = `corbits_triage_state_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: "tnt_state", name: "State", slug: "state", domain: "state.test" });
    await db.insert(schema.principal).values({ id: "prn_github", tenantId: "tnt_state", kind: "user", refId: "github", status: "active" });
    const scope = { tenantId: "tnt_state", principalId: "prn_github" };
    await db.transaction(async function seedCorrupt(tx) {
      await createArtifact(tx, { scope, ownerPrincipalId: null, kind: "document", title: triageStateName(REPO), content: "{not json", source: {} });
    });

    const logged: Array<Record<string, unknown>> = [];
    const store = createTriageStateStore({
      db,
      writerFor: async () => "prn_github",
      log: (entry) => logged.push(entry),
    });
    const unreadable = await store.load("tnt_state", REPO);
    expect(unreadable.rows).toEqual([]);
    expect(unreadable.version).not.toBeNull();
    expect(logged).toContainEqual(expect.objectContaining({ msg: "triage_state_unreadable", repo: REPO }));

    // A legacy integer workflow version still loads, beside a package version.
    const rows: PrTriageRow[] = [{ ...ROW, workflowVersion: 3 }, { ...ROW, number: 8, workflowVersion: "0.1.0-sha-1234abcd" }];
    await store.save("tnt_state", REPO, rows, unreadable.version);
    expect((await store.load("tnt_state", REPO)).rows).toEqual(rows);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
