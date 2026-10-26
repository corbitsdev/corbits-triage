// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { authorize } from "@intx/authz";
import { HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createDB, createGrantStore, runMigrations, schema } from "@intx/db";
import { asRecord } from "@corbits/common";
import { bitbucketConnection } from "../bitbucket-datacenter/records.js";
import { allowCreator } from "./admin-github-grant.js";
import { patchCorbitsTriage, prepareCorbitsTriagePatch, repoRecords, triageNs, type CorbitsTriageNs, type RepoRecord } from "./tenant-config.js";

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
    await db.transaction((tx) => allowCreator(tx, T, MANAGER, `tenant:${T}`, "manage", new Date()));

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
    await db.transaction((tx) => allowCreator(tx, T, MANAGER, "credential:crd_github", "use", new Date()));
    current = await patched(githubOn);
    expect(granted).toEqual(["acme/widgets"]);
    expect(repoRecords(current)[0]?.enabled).toBe(true);

    const bitbucketOn = { ...current, repos: [github, { ...bitbucket, enabled: true }] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(bitbucketOn)))).toEqual([409, "use_bitbucket_route"]);
    current = await store(github, { ...bitbucket, enabled: true, webhookId: 9 });
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq({ ...current, repos: [github] })))).toEqual([409, "use_bitbucket_route"]);
    current = await store(github, bitbucket);

    const pointed = { ...current, repos: [{ ...github, checkPack: { name: "policy", id: "art_other" } }, bitbucket] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(pointed)))).toEqual([403, "forbidden"]);
    current = await store({ ...github, checkPack: { name: "policy", id: "art_pinned" } }, bitbucket);
    const unpinned = { ...current, repos: [{ ...github, checkPack: { name: "policy" } }, bitbucket] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(unpinned)))).toEqual([403, "forbidden"]);
    for (const id of ["art_a", "art_b"]) await db.transaction((tx) => allowCreator(tx, T, MANAGER, `artifact:${id}`, "write", new Date()));
    current = await store({ ...github, checkPack: { name: "policy", id: "art_a" } }, bitbucket);
    current = await patched({ ...current, repos: [{ ...github, checkPack: { name: "policy", id: "art_b" } }, bitbucket] });
    expect(repoRecords(current)[0]?.checkPack).toEqual({ name: "policy", id: "art_b" });

    const added = { ...current, repos: [github, bitbucket, { name: "acme/new", connected: true, enabled: true }] };
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(added)))).toEqual([400, "repo_not_found"]);
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq(null)))).toEqual([400, "invalid_request"]);
    expect(await errorOf(await prepareCorbitsTriagePatch(deps, T, MANAGER, patchReq([])))).toEqual([400, "invalid_request"]);

    // A write landing between the hub's read and its locked write is refused, not overwritten.
    const interleaved = {
      ...deps,
      async authorize(principalId: string, tenantId: string, resource: string, action: string) {
        await patchCorbitsTriage(db, T, (ns) => ({ ...ns, interleaved: true }));
        return deps.authorize(principalId, tenantId, resource, action);
      },
    };
    const repinned = { ...current, repos: [{ ...github, checkPack: { name: "policy", id: "art_a" } }, bitbucket] };
    expect(await errorOf(await prepareCorbitsTriagePatch(interleaved, T, MANAGER, patchReq(repinned)))).toEqual([409, "config_conflict"]);
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
