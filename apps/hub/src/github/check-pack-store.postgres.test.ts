// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema } from "@intx/db";
import { createArtifact, getArtifact, runArtifactMigrations, setArtifactArchived, writeArtifactVersion, type ArtifactDb } from "@corbits/artifacts";
import { CHECK_PACK_KIND, CHECK_PACK_SCHEMA_VERSION, checkPackName, emptyPack, WORKSPACE_POLICY_TITLE_PREFIX } from "@corbits/triage-contracts";
import { loadCheckPack } from "./check-pack-store.js";
import { patchCorbitsTriage, repoRecords } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_policy";
const OTHER = "tnt_policy_other";
const REPO = "acme/widgets";
const SHARED = { kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION, checks: { "ci-green": { enabled: true } }, actions: { when: ["opened"], pass: [], fail: [], unsure: [] } };

function override(sharedId: string) {
  return JSON.stringify({ kind: CHECK_PACK_KIND, schemaVersion: CHECK_PACK_SCHEMA_VERSION, repo: REPO, extends: sharedId, checks: { "ci-green": { enabled: false } } });
}

async function create(db: ArtifactDb, tenantId: string, title: string, content: string): Promise<string> {
  const row = await db.transaction(function createPolicy(tx) {
    return createArtifact(tx, { scope: { tenantId, principalId: `prn_${tenantId}` }, ownerPrincipalId: null, kind: "document", title, content, source: { origin: "manual" } });
  });
  return row.id;
}

test("PostgreSQL: a repository's policy is read by its pinned id, else the newest by title, without writing, resolved over the workspace policy it extends, and names the versions it used", async () => {
  const database = `corbits_policy_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    await runArtifactMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    await db.insert(schema.tenant).values([
      { id: TENANT, name: "Policy", slug: "policy", domain: "policy.test", config: { corbitsTriage: { repos: [{ name: REPO, connected: true, enabled: true }] } } },
      { id: OTHER, name: "Other", slug: "other", domain: "other.test" },
    ]);
    await db.insert(schema.principal).values([
      { id: `prn_${TENANT}`, tenantId: TENANT, kind: "user", refId: "usr_policy", status: "active" },
      { id: `prn_${OTHER}`, tenantId: OTHER, kind: "user", refId: "usr_other", status: "active" },
    ]);
    const deps = { db, artifacts: db, async automaticKinds() { return []; }, log() {} };
    const scope = { tenantId: TENANT, principalId: `prn_${TENANT}` };
    async function pin(id: string): Promise<void> {
      await patchCorbitsTriage(db, TENANT, function savePin(ns) {
        return { ...ns, repos: repoRecords(ns).map((record) => ({ ...record, checkPack: { name: checkPackName(REPO), id } })) };
      });
    }
    async function point(content: string): Promise<void> {
      await writeArtifactVersion(db, { scope, artifactId: repoId, content });
    }
    async function tenantConfig(): Promise<unknown> {
      return (await db.query.tenant.findFirst({ where: eq(schema.tenant.id, TENANT), columns: { config: true } }))?.config;
    }

    const sharedId = await create(db, TENANT, `${WORKSPACE_POLICY_TITLE_PREFIX}base`, JSON.stringify(SHARED));
    const repoId = await create(db, TENANT, checkPackName(REPO), override(sharedId));
    const before = await tenantConfig();
    const first = await loadCheckPack(deps, TENANT, REPO);
    expect(first).toMatchObject({ status: "ok", source: { repo: { id: repoId, version: 1 }, shared: { id: sharedId, version: 1 } } });
    expect(first.status === "ok" && first.pack.checks).toEqual({ "ci-green": { enabled: false } });
    expect(await tenantConfig()).toEqual(before);

    // The portal pins the policy it saves; a newer artifact with the same title is then ignored.
    await pin(repoId);
    const newerId = await create(db, TENANT, checkPackName(REPO), JSON.stringify(emptyPack(REPO)));
    await writeArtifactVersion(db, { scope, artifactId: sharedId, content: JSON.stringify({ ...SHARED, actions: { ...SHARED.actions, when: ["ready"] } }) });
    const second = await loadCheckPack(deps, TENANT, REPO);
    expect(second).toMatchObject({ status: "ok", source: { repo: { id: repoId, version: 1 }, shared: { id: sharedId, version: 2 } } });
    expect(second.status === "ok" && second.pack.actions.when).toEqual(["ready"]);

    const foreignId = await create(db, OTHER, `${WORKSPACE_POLICY_TITLE_PREFIX}base`, JSON.stringify(SHARED));
    await point(override(foreignId));
    expect(await loadCheckPack(deps, TENANT, REPO)).toEqual({ status: "corrupt", reason: "The workspace policy it extends belongs to another workspace.", repo: { id: repoId, version: 2 }, automatic: [] });
    await point(override("art_gone"));
    expect(await loadCheckPack(deps, TENANT, REPO)).toMatchObject({ status: "corrupt", reason: "The workspace policy it extends no longer exists." });
    await point(override(newerId));
    expect(await loadCheckPack(deps, TENANT, REPO)).toMatchObject({ status: "corrupt", reason: "It extends an artifact that is not a workspace policy." });

    await point(JSON.stringify({ ...emptyPack(REPO), checks: { "max-size": { enabled: true }, "not-a-draft": { enabled: true }, size: { enabled: true } } }));
    expect(await loadCheckPack(deps, TENANT, REPO)).toMatchObject({ status: "corrupt", reason: "The policy has unknown checks: max-size." });

    const pinnedConfig = await tenantConfig();
    await setArtifactArchived(db, (await getArtifact(db, repoId))!, true);
    expect(await loadCheckPack(deps, TENANT, REPO)).toMatchObject({ status: "ok", source: { repo: { id: newerId, version: 1 } } });
    expect(await tenantConfig()).toEqual(pinnedConfig);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
