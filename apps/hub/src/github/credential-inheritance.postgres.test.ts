// Requires PostgreSQL at TEST_DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createTenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { TOKEN_CREDENTIAL } from "../bitbucket-datacenter/names.js";
import { activeCredential, githubAppCredential } from "./portal-credential.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const database = `corbits_cred_inherit_${randomBytes(6).toString("hex")}`;
const admin = createDB(TEST_DB);
let handle: ReturnType<typeof createDB>;
const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));

function connected(baseUrl: string) {
  return { corbitsTriage: { bitbucketDatacenter: { baseUrl } } };
}

async function cred(id: string, tenantId: string, name: string, secret: string, status: "active" | "revoked", principalId: string | null = null) {
  await handle.db.insert(schema.credential).values({
    id, tenantId, principalId, providerId: `prv_${tenantId}`, oauthClientId: null, name, type: "api_key",
    secret: await cipher.encrypt(secret, credentialAad(id, "secret")), status,
  });
}

function bitbucketCalls() {
  const hosts: string[] = [];
  const tenantBitbucket = createTenantBitbucket({
    db: handle.db,
    cipher,
    async fetchImpl() {
      return new Response("{}");
    },
    async lookup(hostname: string) {
      hosts.push(hostname);
      return [{ address: "93.184.216.34", family: 4 }];
    },
  } as never);
  return { hosts, tenantBitbucket };
}

beforeAll(async () => {
  await admin.db.execute(sql.raw(`create database ${database}`));
  await runMigrations({ ...TEST_DB, database }, { schema: "public" });
  handle = createDB({ ...TEST_DB, database });
  const tenants = [
    { id: "tnt_parent", name: "P", slug: "p", domain: "p.test", config: connected("https://parent.example") },
    { id: "tnt_revoked", name: "R", slug: "r", domain: "r.test", parentId: "tnt_parent" },
    { id: "tnt_child", name: "C", slug: "c", domain: "c.test", parentId: "tnt_parent", config: connected("https://child.example") },
    { id: "tnt_bare", name: "B", slug: "b", domain: "b.test" },
    { id: "tnt_bare_child", name: "BC", slug: "bc", domain: "bc.test", parentId: "tnt_bare", config: connected("https://child.example") },
    { id: "tnt_personal", name: "N", slug: "n", domain: "n.test", config: connected("https://personal.example") },
    { id: "tnt_personal_child", name: "NC", slug: "nc", domain: "nc.test", parentId: "tnt_personal" },
  ];
  await handle.db.insert(schema.tenant).values(tenants);
  for (const t of tenants) {
    await handle.db.insert(schema.provider).values({ id: `prv_${t.id}`, tenantId: t.id, name: "http", plugin: "http", apiBaseUrl: "https://api.test" });
  }
  await handle.db.insert(schema.principal).values({ id: "prn_personal", tenantId: "tnt_personal", kind: "user", refId: "usr_n", status: "active" });
  await cred("crd_parent_github", "tnt_parent", "github", "PARENT_APP", "active");
  await cred("crd_parent_bb", "tnt_parent", TOKEN_CREDENTIAL, "PARENT_BB", "active");
  await cred("crd_revoked_github", "tnt_revoked", "github", "CHILD_APP", "revoked");
  await cred("crd_bare_bb", "tnt_bare", TOKEN_CREDENTIAL, "BARE_BB", "active");
  await cred("crd_personal_bb", "tnt_personal", TOKEN_CREDENTIAL, "PERSONAL_BB", "active", "prn_personal");
}, 120_000);

afterAll(async () => {
  await handle?.close();
  await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
  await admin.close();
});

test("a revoked workspace credential does not fall through to the parent's", async () => {
  expect(await activeCredential(handle.db, "tnt_revoked", "github")).toBeUndefined();
  const refused = await githubAppCredential({ db: handle.db, cipher, onKeyMoved: noKeyPush, async authorize() { return true; } }, "prn_x", "tnt_revoked", "use");
  expect(refused instanceof Response && refused.status).toBe(409);
});

test("an inherited token goes only to the instance its own workspace connected, and nowhere when that workspace connected none", async () => {
  const { hosts, tenantBitbucket } = bitbucketCalls();
  expect(await tenantBitbucket("tnt_child")).toBeDefined();
  expect(await tenantBitbucket("tnt_bare_child")).toBeUndefined();
  expect(hosts).toEqual(["parent.example"]);
});

test("a personal credential is never resolved as the workspace's, its own or inherited", async () => {
  const { hosts, tenantBitbucket } = bitbucketCalls();
  expect(await tenantBitbucket("tnt_personal")).toBeUndefined();
  expect(await tenantBitbucket("tnt_personal_child")).toBeUndefined();
  expect(hosts).toEqual([]);
});
