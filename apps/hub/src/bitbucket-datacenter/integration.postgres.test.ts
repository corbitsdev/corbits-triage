// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createAutomation } from "../github/automation.js";
import { repoRecords, triageNs } from "../github/tenant-config.js";
import { WEBHOOK_EVENTS } from "./client.js";
import { createBitbucketIntegration } from "./integration.js";
import { HOOK_CREDENTIAL, TOKEN_CREDENTIAL } from "./records.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_bitbucket_enable";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
const BASE_URL = "https://bitbucket.test";
const HOOK_ID = `crd_${HOOK_CREDENTIAL.replaceAll("-", "_")}`;

function instanceFetch(webhookStatus: number) {
  return async function stubInstance(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/default-branch")) return Response.json({ displayId: "main" });
    if (path.endsWith("/webhooks") && init?.method === "POST") return Response.json({ id: 9 }, { status: webhookStatus });
    return Response.json({ slug: "widgets", project: { key: "TRI" } });
  } as typeof fetch;
}

async function failureCode(pending: Promise<Response>): Promise<[number, string]> {
  const res = await pending;
  const body = await res.json() as { error: { code: string } };
  return [res.status, body.error.code];
}

async function withDatabase(run: (db: ReturnType<typeof createDB>["db"], cipher: ReturnType<typeof createEnvKeyCredentialCipher>) => Promise<void>): Promise<void> {
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
    await run(db, cipher);
  } finally {
    await handle?.close();
    await admin.db.execute(sql.raw(`drop database if exists ${database} with (force)`));
    await admin.close();
  }
}

test("PostgreSQL: enabling a Bitbucket repository grants comment and labels and registers its webhook", async () => {
  await withDatabase(async function enableGrants(db, cipher) {
    const integration = createBitbucketIntegration({
      db, cipher, async authorize() { return true; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch(201),
      onEnabled() {}, async onConnectionChanged() {}, now: () => new Date(), log() {},
    });
    const automation = createAutomation({ db, now: () => new Date() });

    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual([]);
    const res = await integration.enable(MEMBER, "TRI", "widgets");
    expect(res.status).toBe(200);
    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual(["labels", "comment"]);
    expect(await (await integration.webhook(MEMBER, "TRI", "widgets")).json()).toEqual({ webhook: "registered", webhookId: 9 });
  });
}, 120_000);

test("PostgreSQL: a hand-made webhook needs use on the hook credential, its setup stays readable while triage is on, and not once it is off", async () => {
  await withDatabase(async function manualWebhook(db, cipher) {
    let hookUse = false;
    let enabledCalls = 0;
    const integration = createBitbucketIntegration({
      db, cipher,
      async authorize(_principal, _tenant, resource) { return resource !== `credential:${HOOK_ID}` || hookUse; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch(403),
      onEnabled() { enabledCalls += 1; }, async onConnectionChanged() {}, now: () => new Date(), log() {},
    });
    async function stored() {
      const tenant = await db.query.tenant.findFirst({ where: (row, { eq }) => eq(row.id, TENANT) });
      return repoRecords(triageNs(tenant?.config)).find((record) => record.name === "TRI/widgets");
    }

    expect((await integration.webhook(MEMBER, "TRI", "widgets")).status).toBe(404);
    const refused = await integration.enable(MEMBER, "TRI", "widgets");
    expect(refused.status).toBe(403);
    expect(await stored()).toBeUndefined();
    expect(enabledCalls).toBe(0);

    hookUse = true;
    for (const attempt of [1, 2]) {
      const res = await integration.enable(MEMBER, "TRI", "widgets");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ webhook: "manual", hookSecret: `secret-${HOOK_CREDENTIAL}` });
      expect(await stored()).toMatchObject({ enabled: true });
      expect((await stored())?.webhookId).toBeUndefined();
      expect(enabledCalls).toBe(attempt);
    }
    hookUse = false;
    expect(await failureCode(integration.webhook(MEMBER, "TRI", "widgets"))).toEqual([403, "forbidden"]);
    hookUse = true;
    const webhook = await integration.webhook(MEMBER, "TRI", "widgets");
    expect(await webhook.json()).toEqual({
      webhook: "manual", hookUrl: `https://hub.test/api/hooks/bitbucket-datacenter/${TENANT}`, hookSecret: `secret-${HOOK_CREDENTIAL}`, events: WEBHOOK_EVENTS,
    });

    expect((await integration.disable(MEMBER, "TRI", "widgets")).status).toBe(200);
    expect(await failureCode(integration.webhook(MEMBER, "TRI", "widgets"))).toEqual([409, "triage_off"]);
  });
}, 120_000);
