// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type } from "arktype";
import { sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { connectTriage, createAutomation } from "../github/automation.js";
import { patchCorbitsTriage, repoRecords, triageNs } from "../github/tenant-config.js";
import { WEBHOOK_EVENTS } from "./client.js";
import { createBitbucketIntegration } from "./integration.js";
import { HOOK_CREDENTIAL, TOKEN_CREDENTIAL } from "./records.js";

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_bitbucket_enable";
const MEMBER = { tenantId: TENANT, principalId: "prn_user" };
const BASE_URL = "https://bitbucket.test";
const HOOK_ID = `crd_${HOOK_CREDENTIAL.replaceAll("-", "_")}`;

async function lookupBitbucket(hostname: string): Promise<readonly { address: string; family: number }[]> {
  if (hostname !== "bitbucket.test") throw new Error(`unexpected host ${hostname}`);
  return [{ address: "8.8.8.8", family: 4 }];
}

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
    await db.transaction((tx) => connectTriage(tx, TENANT, [], new Date()));
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

test("PostgreSQL: enabling a Bitbucket repository grants comment, the one enabled kind the host has, and registers its webhook; disabling it takes the grant", async () => {
  await withDatabase(async function enableGrants(db, cipher) {
    const integration = createBitbucketIntegration({
      db, cipher, onKeyMoved: noKeyPush, async authorize() { return true; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch(201), lookup: lookupBitbucket,
      onEnabled() {}, async onConnectionChanged() {}, onCredentialsReplaced() {}, now: () => new Date(), log() {},
    });
    const automation = createAutomation({ db });

    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual([]);
    const res = await integration.enable(MEMBER, "TRI", "widgets");
    expect(res.status).toBe(200);
    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual(["comment"]);
    expect(await (await integration.webhook(MEMBER, "TRI", "widgets")).json()).toEqual({ webhook: "registered", webhookId: 9 });
    expect((await integration.disable(MEMBER, "TRI", "widgets")).status).toBe(200);
    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual([]);
    expect((await integration.enable(MEMBER, "TRI", "widgets")).status).toBe(200);
    expect(await automation.automaticKinds(TENANT, "TRI/widgets")).toEqual(["comment"]);
  });
}, 120_000);

test("PostgreSQL: a Bitbucket repository named as a GitHub one, in any case, is refused", async () => {
  await withDatabase(async function nameTaken(db, cipher) {
    const integration = createBitbucketIntegration({
      db, cipher, onKeyMoved: noKeyPush, async authorize() { return true; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch(201), lookup: lookupBitbucket,
      onEnabled() {}, async onConnectionChanged() {}, onCredentialsReplaced() {}, now: () => new Date(), log() {},
    });
    await patchCorbitsTriage(db, TENANT, (ns) => ({ ...ns, repos: [{ name: "tri/Widgets", connected: true, installationId: 1 }] }));
    expect(await failureCode(integration.enable(MEMBER, "TRI", "widgets"))).toEqual([409, "repo_name_taken"]);
  });
}, 120_000);

test("PostgreSQL: a hand-made webhook needs use on the hook credential, its setup stays readable while triage is on, and not once it is off", async () => {
  await withDatabase(async function manualWebhook(db, cipher) {
    let hookUse = false;
    let enabledCalls = 0;
    const integration = createBitbucketIntegration({
      db, cipher, onKeyMoved: noKeyPush,
      async authorize(_principal, _tenant, resource) { return resource !== `credential:${HOOK_ID}` || hookUse; },
      async stockFetch() { return new Response(null, { status: 500 }); },
      publicOrigin: "https://hub.test", fetchImpl: instanceFetch(403), lookup: lookupBitbucket,
      onEnabled() { enabledCalls += 1; }, async onConnectionChanged() {}, onCredentialsReplaced() {}, now: () => new Date(), log() {},
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

test("PostgreSQL: rotating the webhook secret stores it, then saves each webhook triage created with it, and leaves the hand-made and unsaved ones to be updated by hand", async () => {
  await withDatabase(async function rotateHookSecret(db, cipher) {
    const writes: Array<{ to: string; secret: string }> = [];
    async function instance(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const path = new URL(String(input)).pathname;
      const slug = /\/repos\/(\w+)/.exec(path)?.[1];
      if (path.endsWith("/default-branch")) return Response.json({ displayId: "main" });
      if (path.endsWith("/webhooks") && init?.method === "POST") return slug === "gadgets" ? new Response(null, { status: 403 }) : Response.json({ id: slug === "widgets" ? 9 : 10 });
      if (init?.method === "PUT") {
        if (slug === "gizmos") return new Response(null, { status: 404 });
        writes.push({ to: path, secret: type({ configuration: { secret: "string" } }).assert(JSON.parse(String(init.body))).configuration.secret });
        return Response.json({ id: 9 });
      }
      return Response.json({ slug, project: { key: "TRI" } });
    }
    async function stock(req: Request): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname.endsWith("/providers")) return Response.json({ data: [{ id: "prv_bitbucket", name: "bitbucket-datacenter", apiBaseUrl: BASE_URL }] });
      if (pathname.endsWith(`/credentials/resolve/${HOOK_CREDENTIAL}`)) return Response.json({ id: HOOK_ID, name: HOOK_CREDENTIAL, status: "active" });
      if (req.method === "PATCH" && pathname.endsWith(`/credentials/${HOOK_ID}`)) {
        writes.push({ to: "vault", secret: type({ secret: "string" }).assert(await req.json()).secret });
        return Response.json({});
      }
      return new Response(null, { status: 500 });
    }
    const integration = createBitbucketIntegration({
      db, cipher, onKeyMoved: noKeyPush, async authorize() { return true; },
      stockFetch: stock, publicOrigin: "https://hub.test", fetchImpl: instance as typeof fetch, lookup: lookupBitbucket,
      onEnabled() {}, async onConnectionChanged() {}, onCredentialsReplaced() {}, now: () => new Date(), log() {},
    });
    for (const slug of ["widgets", "gadgets", "gizmos"]) expect((await integration.enable(MEMBER, "TRI", slug)).status).toBe(200);

    const res = await integration.connect({ rotateHookSecret: true }, MEMBER, new Request("https://hub.test/api/integrations/bitbucket-datacenter"));
    expect(await res.json()).toEqual({ webhooksByHand: ["TRI/gadgets", "TRI/gizmos"] });
    const secret = writes[0]!.secret;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(writes).toEqual([{ to: "vault", secret }, { to: "/rest/api/1.0/projects/TRI/repos/widgets/webhooks/9", secret }]);
    expect(await (await integration.webhook(MEMBER, "TRI", "gizmos")).json()).toMatchObject({ webhook: "manual" });
  });
}, 120_000);
