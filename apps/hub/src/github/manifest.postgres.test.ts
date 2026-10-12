// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { migrateAdminGithubGrants } from "./admin-github-grant.js";
import { createGithubManifestIntegration, migrateGithubManifest } from "./manifest.js";

const PUBLIC_ORIGIN = "https://hub.example.com";
const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const GITHUB_API_ORIGIN = "https://api.github.com";

async function convertManifest(): Promise<Response> {
  return Response.json({ id: 42, slug: "converted", pem: "converted-private-key", webhook_secret: "converted-hook-secret" });
}

function noPreconnect(): void {}

async function signedInSession() {
  return { user: { id: "usr_manifest" }, session: { id: "ses_manifest" } };
}

async function allow(): Promise<boolean> {
  return true;
}

test("PostgreSQL: a canonical insert after start is preserved and remains decryptable", async () => {
  const testSchema = `corbits_manifest_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateGithubManifest(db);

    await db.insert(schema.tenant).values({
      id: "tnt_manifest", name: "Manifest", slug: "manifest", domain: "manifest.test",
    });
    await db.insert(schema.principal).values({
      id: "prn_manifest", tenantId: "tnt_manifest", kind: "user", refId: "usr_manifest", status: "active",
    });
    await db.insert(schema.provider).values({
      id: "prv_github", tenantId: "tnt_manifest", name: "github", plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN,
    });

    const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
    const integration = createGithubManifestIntegration({
      db,
      cipher,
      getSession: signedInSession,
      authorizeCredential: allow,
      trustedPortalOrigins: [PUBLIC_ORIGIN],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: PUBLIC_ORIGIN,
      fetchImpl: Object.assign(convertManifest, { preconnect: noPreconnect }),
    });

    // Behind a TLS-terminating proxy the hub sees plain http; GitHub must get the public https URLs.
    const start = await integration.start(new Request(
      "http://hub.example.com/api/integrations/github-manifest/tnt_manifest/start",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ portalOrigin: PUBLIC_ORIGIN, replace: false }),
      },
    ), "tnt_manifest");
    expect(start.status).toBe(201);
    const { state, manifest } = await start.json() as { state: string; manifest: { redirect_url: string; hook_attributes: { url: string } } };
    expect(manifest.redirect_url).toBe(`${PUBLIC_ORIGIN}/api/integrations/github-manifest/callback`);
    expect(manifest.hook_attributes.url).toBe(`${PUBLIC_ORIGIN}/api/hooks/tnt_manifest/github-hook`);

    const appId = "crd_concurrent_app";
    const hookId = "crd_concurrent_hook";
    const appPlaintext = JSON.stringify({ appId: "attacker-kept", privateKey: "attacker-private-key" });
    const hookPlaintext = "attacker-hook-secret";
    const appCiphertext = await cipher.encrypt(appPlaintext, credentialAad(appId, "secret"));
    const hookCiphertext = await cipher.encrypt(hookPlaintext, credentialAad(hookId, "secret"));
    await db.insert(schema.credential).values([
      {
        id: appId, tenantId: "tnt_manifest", principalId: null, providerId: "prv_github", oauthClientId: null,
        name: "github", type: "api_key", secret: appCiphertext, status: "active",
      },
      {
        id: hookId, tenantId: "tnt_manifest", principalId: null, providerId: "prv_github", oauthClientId: null,
        name: "github-hook", type: "api_key", secret: hookCiphertext, status: "active",
      },
    ]);

    const callback = await integration.callback(new Request(
      `https://hub.example/api/integrations/github-manifest/callback?state=${encodeURIComponent(state)}&code=conversion-code`,
    ));
    expect(callback.status).toBe(400);

    const rows = await db.select().from(schema.credential).where(and(
      eq(schema.credential.tenantId, "tnt_manifest"),
      sql`${schema.credential.name} IN ('github', 'github-hook')`,
    ));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.name === "github")).toMatchObject({ id: appId, secret: appCiphertext });
    expect(rows.find((row) => row.name === "github-hook")).toMatchObject({ id: hookId, secret: hookCiphertext });
    expect(await cipher.decrypt(appCiphertext, credentialAad(appId, "secret"))).toBe(appPlaintext);
    expect(await cipher.decrypt(hookCiphertext, credentialAad(hookId, "secret"))).toBe(hookPlaintext);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);

test("PostgreSQL: completing setup lets admins act on GitHub, once across reconnects", async () => {
  const testSchema = `corbits_manifest_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await migrateGithubManifest(db);

    await db.insert(schema.tenant).values({
      id: "tnt_manifest", name: "Manifest", slug: "manifest", domain: "manifest.test",
    });
    await db.insert(schema.principal).values({
      id: "prn_manifest", tenantId: "tnt_manifest", kind: "user", refId: "usr_manifest", status: "active",
    });
    await db.insert(schema.provider).values({
      id: "prv_github", tenantId: "tnt_manifest", name: "github", plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN,
    });
    await db.insert(schema.role).values({ id: "rol_admin", tenantId: "tnt_manifest", name: "admin", isSystem: true });

    const integration = createGithubManifestIntegration({
      db,
      cipher: createEnvKeyCredentialCipher(new Uint8Array(32).fill(7)),
      getSession: signedInSession,
      authorizeCredential: allow,
      trustedPortalOrigins: [PUBLIC_ORIGIN],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: PUBLIC_ORIGIN,
      fetchImpl: Object.assign(convertManifest, { preconnect: noPreconnect }),
    });

    async function connect(replace: boolean): Promise<number> {
      const start = await integration.start(new Request(
        `${PUBLIC_ORIGIN}/api/integrations/github-manifest/tnt_manifest/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
          body: JSON.stringify({ portalOrigin: PUBLIC_ORIGIN, replace }),
        },
      ), "tnt_manifest");
      const { state } = await start.json() as { state: string };
      const callback = await integration.callback(new Request(
        `${PUBLIC_ORIGIN}/api/integrations/github-manifest/callback?state=${encodeURIComponent(state)}&code=conversion-code`,
      ));
      return callback.status;
    }

    expect(await connect(false)).toBe(303);
    expect(await connect(true)).toBe(303);

    const [app] = await db.select().from(schema.credential).where(and(
      eq(schema.credential.tenantId, "tnt_manifest"),
      eq(schema.credential.name, "github"),
    ));
    const grants = await db.select().from(schema.grant).where(eq(schema.grant.roleId, "rol_admin"));
    expect(grants.map(({ resource, action, effect, origin }) => ({ resource, action, effect, origin }))).toEqual([
      { resource: `credential:${app?.id}`, action: "use", effect: "allow", origin: "role" },
      { resource: "github-review:*", action: "approve", effect: "allow", origin: "role" },
    ]);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);

test("PostgreSQL: a workspace set up before admins could approve gets the grant at one start, and an owner's removal stays", async () => {
  const testSchema = `corbits_manifest_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;
    await db.insert(schema.tenant).values({ id: "tnt_older", name: "Older", slug: "older", domain: "older.test" });
    await db.insert(schema.provider).values({ id: "prv_github", tenantId: "tnt_older", name: "github", plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN });
    await db.insert(schema.role).values({ id: "rol_admin", tenantId: "tnt_older", name: "admin", isSystem: true });
    await db.insert(schema.credential).values({
      id: "crd_github", tenantId: "tnt_older", principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key", secret: "sealed", status: "active",
    });
    await db.insert(schema.grant).values({ id: "grt_use", tenantId: "tnt_older", roleId: "rol_admin", resource: "credential:crd_github", action: "use", effect: "allow", origin: "role" });

    async function adminGrants() {
      const grants = await db.select().from(schema.grant).where(eq(schema.grant.roleId, "rol_admin"));
      return grants.map(({ resource, action }) => ({ resource, action }));
    }

    await migrateAdminGithubGrants(db);
    await migrateAdminGithubGrants(db);
    expect(await adminGrants()).toEqual([
      { resource: "credential:crd_github", action: "use" },
      { resource: "github-review:*", action: "approve" },
    ]);

    await db.delete(schema.grant).where(and(eq(schema.grant.roleId, "rol_admin"), eq(schema.grant.action, "approve")));
    await migrateAdminGithubGrants(db);
    expect(await adminGrants()).toEqual([{ resource: "credential:crd_github", action: "use" }]);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
