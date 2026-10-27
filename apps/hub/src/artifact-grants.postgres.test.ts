// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { count, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createDB, createGrantStore, runMigrations, schema } from "@intx/db";
import { createArtifact, runArtifactMigrations } from "@corbits/artifacts";
import { checkPackName } from "@corbits/triage-contracts";
import { createArtifactGrants, grantAdminsPolicyWrites } from "./artifact-grants.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_artifact_grants";

test("PostgreSQL: an artifact is writable and archivable by its creator and admins only, and policies made before are granted to admins once", async () => {
  const database = `corbits_artifact_grants_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Grants", slug: "grants", domain: "grants.test" });
    await db.insert(schema.principal).values(["creator", "member", "admin"].map((name) => ({ id: `prn_${name}`, tenantId: TENANT, kind: "user" as const, refId: `usr_${name}`, status: "active" as const })));
    await db.insert(schema.role).values({ id: "rol_admin", tenantId: TENANT, name: "admin", isSystem: true });
    await db.insert(schema.principalRole).values({ principalId: "prn_admin", roleId: "rol_admin" });
    const scope = { tenantId: TENANT, principalId: "prn_creator" };
    const now = () => new Date();
    const grantWriters = createArtifactGrants(now);
    const created = await db.transaction(async function createWithGrants(tx) {
      const row = await createArtifact(tx, { scope, ownerPrincipalId: "prn_creator", kind: "document", title: checkPackName("acme/base", "github"), content: "{}", source: { origin: "manual" } });
      await grantWriters(tx, row, scope);
      return row;
    });
    const earlier = await db.transaction(function createBeforeGrants(tx) {
      return createArtifact(tx, { scope, ownerPrincipalId: "prn_creator", kind: "document", title: checkPackName("acme/widgets", "github"), content: "{}", source: { origin: "manual" } });
    });

    const grants = createGrantStore(db);
    async function may(principalId: string, artifactId: string): Promise<boolean[]> {
      const actions = ["write", "archive"];
      return Promise.all(actions.map(async function allowed(action) {
        return (await authorize(grants, principalId, TENANT, `artifact:${artifactId}`, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
      }));
    }
    expect(await may("prn_creator", created.id)).toEqual([true, true]);
    expect(await may("prn_admin", created.id)).toEqual([true, true]);
    expect(await may("prn_member", created.id)).toEqual([false, false]);
    expect(await may("prn_admin", earlier.id)).toEqual([false, false]);

    await grantAdminsPolicyWrites(db, now, function ignore() {});
    await grantAdminsPolicyWrites(db, now, function ignore() {});
    expect(await may("prn_admin", earlier.id)).toEqual([true, true]);
    expect(await may("prn_member", earlier.id)).toEqual([false, false]);
    expect(await db.select({ n: count() }).from(schema.grant)).toEqual([{ n: 6 }]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
