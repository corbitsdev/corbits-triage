// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createDB, createGrantStore, runMigrations, schema } from "@intx/db";
import { asRecord } from "@corbits/common";
import { bitbucketConnection } from "../bitbucket-datacenter/records.js";
import { connectTriage, grantWanted } from "./automation.js";
import { keepExistingWorkspacesAsking, patchCorbitsTriage, prepareCorbitsTriagePatch, repoRecords, triageNs, type CorbitsTriageNs, type RepoRecord } from "./tenant-config.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const T = "tnt_patch";
const MANAGER = "prn_manager";

function patchReq(ns: unknown): Request {
  return new Request(`https://hub/api/tenants/${T}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: { corbitsTriage: ns } }) });
}

async function errorOf(res: Request | Response): Promise<[number, unknown]> {
  if (!(res instanceof Response)) throw new Error("the patch was let through");
  const error = asRecord(await res.json())?.["error"];
  return [res.status, asRecord(error)?.["code"] ?? error];
}

async function forwardedConfig(res: Request | Response): Promise<unknown> {
  if (res instanceof Response) throw new Error(`refused ${res.status}`);
  return asRecord(await res.json())?.["config"];
}

test("PostgreSQL: a manager's tenant patch keeps the connection, code review and repository state stored, and each change needs the grant of its own route", async () => {
  const database = `corbits_patch_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    const repos: RepoRecord[] = [
      { name: "acme/widgets", connected: true, installationId: 7, enabled: false },
      { name: "TRI/widgets", source: "bitbucket-datacenter", connected: true, enabled: false },
    ];
    const stored = { rev: 2, bitbucketDatacenter: { baseUrl: "https://bitbucket.example", user: "triage" }, repos };
    await db.insert(schema.tenant).values({ id: T, name: "Patch", slug: "patch", domain: "patch.test", config: { corbitsTriage: stored } });
    await db.insert(schema.principal).values({ id: MANAGER, tenantId: T, kind: "user", refId: "usr_manager", status: "active" });
    await db.insert(schema.provider).values({ id: "prv_github", tenantId: T, name: "github", plugin: "http", apiBaseUrl: "https://api.github.test" });
    await db.insert(schema.credential).values({ id: "crd_github", tenantId: T, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key", secret: "unused", status: "active" });
    await db.insert(schema.grant).values({ id: "grt_manager_tenant", tenantId: T, principalId: MANAGER, resource: `tenant:${T}`, action: "manage", effect: "allow", origin: "creator" });

    const grants = createGrantStore(db);
    const granted: string[] = [];
    const deps = {
      db,
      async authorize(principalId: string, tenantId: string, resource: string, action: string) {
        return (await authorize(grants, principalId, tenantId, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
      },
      async grantEnabled(_tx: unknown, repo: string) {
        granted.push(repo);
      },
      now: () => new Date(),
    };

    async function storedNs(): Promise<CorbitsTriageNs> {
      const [row] = await db.select().from(schema.tenant).where(eq(schema.tenant.id, T));
      return triageNs(row?.config);
    }
    async function store(github: RepoRecord, bitbucket?: RepoRecord): Promise<CorbitsTriageNs> {
      await patchCorbitsTriage(db, T, function setRepos(ns) {
        return { ...ns, repos: bitbucket ? [github, bitbucket] : [github] };
      });
      return storedNs();
    }
    async function patched(ns: CorbitsTriageNs): Promise<CorbitsTriageNs> {
      expect(await forwardedConfig(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(ns)))).toEqual({});
      return storedNs();
    }

    const attack = {
      ...stored,
      bitbucketDatacenter: { baseUrl: "https://attacker.example", user: "triage" },
      inference: { endpoint: "https://attacker.example", model: "m" },
      repos: [
        { ...repos[0], connected: false, installationId: 99 },
        { ...repos[1], webhookId: 9 },
      ],
    };
    let current = await patched(attack);
    expect(current).toEqual({ ...stored, rev: 3 });
    expect(bitbucketConnection(current)?.baseUrl).toBe("https://bitbucket.example");
    const [github, bitbucket] = repoRecords(current);

    const githubOn = { ...current, repos: [{ ...github, enabled: true }, bitbucket] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(githubOn)))).toEqual([403, "forbidden"]);
    expect(granted).toEqual([]);
    await db.insert(schema.grant).values({ id: "grt_manager_github", tenantId: T, principalId: MANAGER, resource: "credential:crd_github", action: "use", effect: "allow", origin: "creator" });
    current = await patched(githubOn);
    expect(granted).toEqual(["acme/widgets"]);
    expect(repoRecords(current)[0]?.enabled).toBe(true);

    const bitbucketOn = { ...current, repos: [github, { ...bitbucket, enabled: true }] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(bitbucketOn)))).toEqual([409, "use_bitbucket_route"]);
    current = await store(github, { ...bitbucket, enabled: true, webhookId: 9 });
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq({ ...current, repos: [github] })))).toEqual([409, "use_bitbucket_route"]);
    current = await store(github, bitbucket);

    const added = { ...current, repos: [github, bitbucket, { name: "acme/new", connected: true, enabled: true }] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(added)))).toEqual([400, "repo_not_found"]);
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(null)))).toEqual([400, "invalid_request"]);
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq([])))).toEqual([400, "invalid_request"]);

    // Switching to ask takes back every kind a policy granted on an enabled repository but posting.
    await db.transaction((tx) => connectTriage(tx, T, [], new Date()));
    current = await store({ ...github, enabled: true }, bitbucket);
    await db.transaction((tx) => grantWanted(tx, T, github.name, "github", ["merge"], new Date()));
    async function roleGrants(): Promise<string[]> {
      return (await db.select({ resource: schema.grant.resource }).from(schema.grant).where(and(eq(schema.grant.tenantId, T), isNotNull(schema.grant.roleId)))).map((row) => row.resource).sort();
    }
    expect(await roleGrants()).toEqual(["triage-do:comment:github:acme/widgets", "triage-do:labels:github:acme/widgets", "triage-do:merge:github:acme/widgets"]);
    current = await patched({ ...current, automation: "ask" });
    expect(await roleGrants()).toEqual(["triage-do:comment:github:acme/widgets", "triage-do:labels:github:acme/widgets"]);
    current = await store(github, bitbucket);

    // The workspace's automation is set by name, and a patch that leaves it out keeps it.
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq({ ...current, automation: "always" })))).toEqual([400, "invalid_request"]);
    current = await patched({ ...current, automation: "ask" });
    const { automation: _automation, ...withoutAutomation } = current;
    current = await patched(withoutAutomation);
    expect(current["automation"]).toBe("ask");

    // A write landing between the hub's read and its locked write is refused, not overwritten.
    const interleaved = {
      ...deps,
      async authorize(principalId: string, tenantId: string, resource: string, action: string) {
        await patchCorbitsTriage(db, T, (ns) => ({ ...ns, interleaved: true }));
        return deps.authorize(principalId, tenantId, resource, action);
      },
    };
    const switchedOn = { ...current, repos: [{ ...github, enabled: true }, bitbucket] };
    expect(await errorOf(await prepareCorbitsTriagePatch(interleaved, T, MANAGER, patchReq(switchedOn)))).toEqual([409, "config_conflict"]);
    current = await storedNs();
    expect(current["interleaved"]).toBe(true);

    const kept = repoRecords(current)[0];
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, new Request(`https://hub/api/tenants/${T}`, { method: "PATCH", body: JSON.stringify({ name: 7, config: { corbitsTriage: { ...current, repos: [kept] } } }) })))).toEqual([400, "invalid_request"]);
    expect(await storedNs()).toEqual(current);
    const removed = await patched({ ...current, repos: [kept] });
    expect(removed.repos).toEqual([kept]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);

test("PostgreSQL: a workspace set up before automation existed is kept asking once, with its grants, and a new one starts under policy", async () => {
  const database = `corbits_asking_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    const repos: RepoRecord[] = [{ name: "acme/widgets", connected: true, installationId: 7, enabled: true }];
    await db.insert(schema.tenant).values([
      { id: "tnt_existing", name: "Existing", slug: "existing", domain: "existing.test", config: { corbitsTriage: { rev: 4, repos } } },
      { id: "tnt_chosen", name: "Chosen", slug: "chosen", domain: "chosen.test", config: { corbitsTriage: { rev: 1, repos, automation: "policy" } } },
      { id: "tnt_new", name: "New", slug: "new", domain: "new.test" },
    ]);
    await db.transaction(async function grantByHand(tx) {
      await connectTriage(tx, "tnt_existing", [], new Date());
      await grantWanted(tx, "tnt_existing", "acme/widgets", "github", ["merge"], new Date());
    });
    async function nsOf(tenantId: string): Promise<CorbitsTriageNs> {
      const [row] = await db.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      return triageNs(row?.config);
    }
    const logged: Array<Record<string, unknown>> = [];
    function log(entry: Record<string, unknown>) {
      logged.push(entry);
    }

    await keepExistingWorkspacesAsking(db, log);
    await keepExistingWorkspacesAsking(db, log);

    expect(await nsOf("tnt_existing")).toEqual({ rev: 5, repos, automation: "ask" });
    expect(await nsOf("tnt_chosen")).toEqual({ rev: 1, repos, automation: "policy" });
    expect(await nsOf("tnt_new")).toEqual({});
    expect(logged).toEqual([{ level: "info", msg: "existing_workspaces_kept_asking", workspaces: 1 }]);
    const kept = await db.select({ resource: schema.grant.resource }).from(schema.grant).where(and(eq(schema.grant.tenantId, "tnt_existing"), isNotNull(schema.grant.roleId)));
    expect(kept.map((row) => row.resource).sort()).toEqual(["triage-do:comment:github:acme/widgets", "triage-do:labels:github:acme/widgets", "triage-do:merge:github:acme/widgets"]);

    await patchCorbitsTriage(db, "tnt_new", (ns) => ({ ...ns, repos: [] }));
    expect(await nsOf("tnt_new")).toEqual({ repos: [], automation: "policy", rev: 1 });
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
