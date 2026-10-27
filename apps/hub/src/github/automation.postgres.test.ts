// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { createDB, runMigrations, schema, type DB } from "@intx/db";
import { DO_GRANT_ACTION, doResource, emptyPack, readCheckPack, TRIAGE_ROLE, type AutomationMode, type Step } from "@corbits/triage-contracts";
import { holdDos, type SuggestedDo } from "@corbits/triage-workflows/logic/actions";
import { allowRole } from "./admin-github-grant.js";
import { connectTriage, createAutomation, grantEnabledKinds } from "./automation.js";
import { createPolicyGrants } from "./policy-grants.js";
import { previewRepoPolicy, type CheckPackRead } from "./repo-policy.js";
import { patchCorbitsTriage, type RepoRecord } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_automation";
const REPO = "acme/api";

async function noSharedFile(): Promise<never> {
  throw new Error("No policy here extends another.");
}

async function inFreshDatabase(run: (db: DB["db"]) => Promise<void>): Promise<void> {
  const database = `corbits_automation_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Automation", slug: "automation", domain: "automation.test" });
    await run(handle.db);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: a Do runs unattended only while the pr-triage role holds its kind's grant, and switching a repository off or removing it takes its grants", async () => {
  await inFreshDatabase(async function grantsFollowTheRepository(db) {
    const automation = createAutomation({ db });
    async function held(): Promise<boolean> {
      const suggested: SuggestedDo = { list: "pass", index: 0, kind: "labels", reason: "", effectId: "e-labels", target: { labels: ["api"] } };
      const [step] = holdDos([suggested], await automation.automaticKinds(TENANT, REPO));
      return (step as SuggestedDo).held === true;
    }

    expect(await held()).toBe(true);
    expect(await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT))).toEqual([]);
    await db.transaction((tx) => connectTriage(tx, TENANT, [], new Date()));
    const [role] = await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT));
    expect(role).toEqual(expect.objectContaining({ name: TRIAGE_ROLE, isSystem: true }));
    await db.insert(schema.grant).values({ id: "grt_triage_labels", tenantId: TENANT, roleId: role!.id, resource: "triage-do:labels:*", action: "invoke", effect: "allow", origin: "role" });
    expect(await held()).toBe(false);
    await db.delete(schema.grant).where(eq(schema.grant.roleId, role!.id));
    expect(await held()).toBe(true);

    await Promise.all(Array.from({ length: 8 }, function racingAllow() {
      return db.transaction((tx) => allowRole(tx, TENANT, role!.id, doResource("labels", REPO), DO_GRANT_ACTION, new Date()));
    }));
    expect(await db.select().from(schema.grant).where(eq(schema.grant.roleId, role!.id))).toHaveLength(1);

    const off: RepoRecord = { name: REPO, connected: true, installationId: 7, enabled: false };
    async function store(record: RepoRecord | undefined): Promise<void> {
      await patchCorbitsTriage(db, TENANT, async function setRepo(ns, tx) {
        if (record?.enabled) await grantEnabledKinds(tx, TENANT, REPO, "github", new Date());
        return { ...ns, repos: record ? [record] : [] };
      });
    }
    await store({ ...off, enabled: true });
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual(["labels", "comment"]);
    await store(off);
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual([]);
    // A grant left on a switched-off repository, as one from before grants followed the policy, does not come back on enable.
    await db.transaction((tx) => allowRole(tx, TENANT, role!.id, doResource("merge", REPO), DO_GRANT_ACTION, new Date()));
    await store({ ...off, enabled: true });
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual(["labels", "comment"]);
    await store(undefined);
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual([]);
    expect(await db.select().from(schema.role).where(eq(schema.role.tenantId, TENANT))).toHaveLength(1);
  });
}, 120_000);

test("PostgreSQL: under policy automation each read of an enabled repository grants what its policy uses and takes back what it dropped, under ask only posting is granted, and a failed read changes nothing", async () => {
  await inFreshDatabase(async function grantsFollowThePolicy(db) {
    await db.transaction((tx) => connectTriage(tx, TENANT, [], new Date()));
    const automation = createAutomation({ db });
    let newest = "v1";
    const grants = createPolicyGrants({
      db,
      automaticKinds: automation.automaticKinds,
      preview(tenantId, repo, source, text) {
        return previewRepoPolicy({ policyFile: noSharedFile, automaticKinds: automation.automaticKinds }, tenantId, repo, source, text);
      },
      isNewest: (_tenantId, _repo, _source, sha) => sha === newest,
      now: () => new Date(),
    });
    const BITBUCKET = "PROJ/api";
    const repos: RepoRecord[] = [{ name: REPO, connected: true, installationId: 7, enabled: true }, { name: BITBUCKET, source: "bitbucket-datacenter", connected: true, enabled: true }];
    await patchCorbitsTriage(db, TENANT, async function enable(ns, tx) {
      await grantEnabledKinds(tx, TENANT, REPO, "github", new Date());
      await grantEnabledKinds(tx, TENANT, BITBUCKET, "bitbucket-datacenter", new Date());
      return { ...ns, repos, automation: "ask" };
    });
    async function setMode(automation: AutomationMode | undefined): Promise<void> {
      await patchCorbitsTriage(db, TENANT, (ns) => ({ ...ns, automation }));
    }
    function read(repo: string, pass: Step[]): Extract<CheckPackRead, { status: "ok" }> {
      return { status: "ok", pack: readCheckPack({ ...emptyPack(repo), actions: { when: ["opened"], pass, fail: [], unsure: [] } }, repo), automatic: [], source: {} };
    }
    async function rows(): Promise<string[]> {
      return (await db.select({ id: schema.grant.id }).from(schema.grant).where(eq(schema.grant.tenantId, TENANT))).map((row) => row.id).sort();
    }
    const assignAndMerge = read(REPO, [{ do: "assign", target: { to: "author" } }, { do: "merge" }]);
    const assignFile = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\nactions:\n  pass:\n    - do: assign\n      target:\n        to: author\n";

    // Under ask a read writes nothing, and a policy pull request names what will wait.
    expect(await grants.followPolicy(TENANT, REPO, "github", assignAndMerge)).toEqual(assignAndMerge);
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual(["labels", "comment"]);
    expect(await grants.waitingKinds(TENANT, REPO, "github", assignFile)).toEqual(["assign"]);

    // Absent is policy: the next read grants what the policy uses and carries it, and reading it again touches no row.
    await setMode(undefined);
    expect(await grants.waitingKinds(TENANT, REPO, "github", assignFile)).toEqual([]);
    expect(await grants.followPolicy(TENANT, REPO, "github", assignAndMerge)).toMatchObject({ status: "ok", automatic: ["labels", "assign", "comment", "merge"] });
    const granted = await rows();
    await grants.followPolicy(TENANT, REPO, "github", assignAndMerge);
    expect(await rows()).toEqual(granted);

    // A refused or missing policy changes nothing; one that drops a step takes its grant back and keeps posting.
    await grants.followPolicy(TENANT, REPO, "github", { status: "invalid", reason: "broken", path: ".corbits-triage.yml", automatic: [] });
    await grants.followPolicy(TENANT, REPO, "github", { status: "missing" });
    expect(await rows()).toEqual(granted);
    // A read a newer read of the file overtook grants nothing, so it cannot undo what the newer one granted.
    newest = "v2";
    await grants.followPolicy(TENANT, REPO, "github", { ...read(REPO, []), source: { file: { path: ".corbits-triage.yml", sha: "v1" } } });
    expect(await rows()).toEqual(granted);
    await grants.followPolicy(TENANT, REPO, "github", read(REPO, [{ do: "merge" }]));
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual(["labels", "comment", "merge"]);

    // Bitbucket Data Center the same, with only the kinds it can write.
    await grants.followPolicy(TENANT, BITBUCKET, "bitbucket-datacenter", read(BITBUCKET, [{ do: "assign", target: { to: "author" } }, { do: "approve" }]));
    expect(await automation.automaticKinds(TENANT, BITBUCKET)).toEqual(["comment", "approve"]);

    // Back to ask leaves posting alone and takes the rest back, and a repository switched off is not granted again.
    await setMode("ask");
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual(["labels", "comment"]);
    expect(await automation.automaticKinds(TENANT, BITBUCKET)).toEqual(["comment"]);
    const held = await rows();
    await grants.followPolicy(TENANT, REPO, "github", assignAndMerge);
    expect(await rows()).toEqual(held);
    await setMode("policy");
    await patchCorbitsTriage(db, TENANT, (ns) => ({ ...ns, repos: [{ ...repos[0]!, enabled: false }, repos[1]!] }));
    await grants.followPolicy(TENANT, REPO, "github", assignAndMerge);
    expect(await automation.automaticKinds(TENANT, REPO)).toEqual([]);
    expect((await db.select().from(schema.grant).where(eq(schema.grant.tenantId, TENANT))).every((row) => row.principalId === null)).toBe(true);
  });
}, 120_000);
