// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { createArtifact, getArtifact, runArtifactMigrations } from "@corbits/artifacts";
import { checkPackName, emptyPack } from "@corbits/triage-contracts";
import { archiveStoredPolicies } from "./stored-policies.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const REPO = "acme/widgets";

test("PostgreSQL: every stored policy in every tenant is archived once, and no other artifact is touched", async () => {
  const database = `corbits_stored_policies_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const { db } = handle;
    const tenants = ["tnt_one", "tnt_two"];
    await db.insert(schema.tenant).values(tenants.map((id) => ({ id, name: id, slug: id.replace("_", "-"), domain: `${id.replace("_", "-")}.test` })));
    await db.insert(schema.principal).values(tenants.map((id) => ({ id: `prn_${id}`, tenantId: id, kind: "user" as const, refId: `usr_${id}`, status: "active" as const })));
    async function create(tenantId: string, title: string): Promise<string> {
      const row = await db.transaction(function createOne(tx) {
        return createArtifact(tx, { scope: { tenantId, principalId: `prn_${tenantId}` }, ownerPrincipalId: null, kind: "document", title, content: JSON.stringify(emptyPack(REPO)), source: { origin: "manual" } });
      });
      return row.id;
    }
    const policies = [await create("tnt_one", checkPackName(REPO, "github")), await create("tnt_two", checkPackName(REPO, "bitbucket-datacenter"))];
    const state = await create("tnt_one", `triage-state/${REPO}`);

    const logged: Array<Record<string, unknown>> = [];
    await archiveStoredPolicies(db, db, function log(entry) { logged.push(entry); });
    await archiveStoredPolicies(db, db, function log(entry) { logged.push(entry); });

    for (const id of policies) expect((await getArtifact(db, id))?.archivedAt).toBeInstanceOf(Date);
    expect((await getArtifact(db, state))?.archivedAt).toBeNull();
    expect(logged).toEqual([{ level: "info", msg: "stored_policies_archived", policies: 2 }]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
