// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createAutomation } from "../github/automation.js";
import { createBitbucketIntegration } from "./integration.js";
import { HOOK_CREDENTIAL, TOKEN_CREDENTIAL } from "./records.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_bitbucket_enable";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
const BASE_URL = "https://bitbucket.test";

async function instanceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/default-branch")) return Response.json({ displayId: "main" });
  if (path.endsWith("/webhooks") && init?.method === "POST") return Response.json({ id: 9 });
  return Response.json({ slug: "widgets", project: { key: "TRI" } });
}

test("PostgreSQL: enabling a Bitbucket repository grants comment and labels", async () => {
  const database = `corbits_bitbucket_${randomBytes(6).toString("hex")}`;
  const admin = createDB(TEST_DB);
  await admin.db.execute(sql.raw(`create database ${database}`));
  const config = { ...TEST_DB, database };
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(config, { schema: "public" });
    handle = createDB(config);
    const db = handle.db;
    const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
    await db.insert(schema.tenant).values({
      id: TENANT, name: "Bitbucket", slug: "bitbucket", domain: "bitbucket.test", config: { corbitsTriage: { bitbucketDatacenter: { baseUrl: BASE_URL } } },
    });
    await db.insert(schema.provider).values({ id: "prv_bitbucket", tenantId: TENANT, name: "bitbucket-datacenter", plugin: "http", apiBaseUrl: BASE_URL });
    for (const name of [TOKEN_CREDENTIAL, HOOK_CREDENTIAL]) {
      const id = `crd_${name.replaceAll("-", "_")}`;
      await db.insert(schema.credential).values({
        id, tenantId: TENANT, principalId: null, providerId: "prv_bitbucket", oauthClientId: null, name, type: "api_key",
        secret: await cipher.encrypt(`secret-${name}`, credentialAad(id, "secret")), status: "active",
      });
    }
    const integration = createBitbucketIntegration({
      db, cipher, async authorize() { return true; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch as typeof fetch,
      onEnabled() {}, async onConnectionChanged() {}, now: () => new Date(), log() {},
    });
    const automation = createAutomation({ db, now: () => new Date() });

    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual([]);
    const res = await integration.enable(MEMBER, "TRI", "widgets");
    expect(res.status).toBe(200);
    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual(["labels", "comment"]);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}, 120_000);
