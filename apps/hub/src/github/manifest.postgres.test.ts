// Requires PostgreSQL at TEST_DB.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import { createGithubManifestIntegration } from "./manifest.js";

const PUBLIC_ORIGIN = "https://hub.example.com";
const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const GITHUB_API_ORIGIN = "https://api.github.com";
const STATE_SECRET = "33".repeat(32);

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

test("PostgreSQL: completing setup lets admins act on GitHub, once across reconnects", async () => {
  const testSchema = `corbits_manifest_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;

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
      stateSecret: STATE_SECRET,
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
      { resource: "triage-do:*", action: "invoke", effect: "allow", origin: "role" },
    ]);
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);

test("PostgreSQL: a setup state commits credentials once, fresh or replacing", async () => {
  const testSchema = `corbits_manifest_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const db = handle.db;

    await db.insert(schema.tenant).values({
      id: "tnt_manifest", name: "Manifest", slug: "manifest", domain: "manifest.test",
    });
    await db.insert(schema.principal).values({
      id: "prn_manifest", tenantId: "tnt_manifest", kind: "user", refId: "usr_manifest", status: "active",
    });
    await db.insert(schema.provider).values({
      id: "prv_github", tenantId: "tnt_manifest", name: "github", plugin: "http", apiBaseUrl: GITHUB_API_ORIGIN,
    });

    // Worst case: GitHub converts the code again instead of refusing it.
    let conversions = 0;
    async function convertEveryTime(): Promise<Response> {
      conversions += 1;
      return Response.json({ id: conversions, slug: `app-${conversions}`, pem: `key-${conversions}`, webhook_secret: `hook-${conversions}` });
    }
    const cipher = createEnvKeyCredentialCipher(new Uint8Array(32).fill(7));
    const integration = createGithubManifestIntegration({
      db,
      cipher,
      getSession: signedInSession,
      authorizeCredential: allow,
      stateSecret: STATE_SECRET,
      trustedPortalOrigins: [PUBLIC_ORIGIN],
      githubApiOrigin: GITHUB_API_ORIGIN,
      publicOrigin: PUBLIC_ORIGIN,
      fetchImpl: Object.assign(convertEveryTime, { preconnect: noPreconnect }),
    });
    async function callbackStatuses(replace: boolean): Promise<number[]> {
      const start = await integration.start(new Request(
        `${PUBLIC_ORIGIN}/api/integrations/github-manifest/tnt_manifest/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: PUBLIC_ORIGIN, "sec-fetch-site": "same-origin" },
          body: JSON.stringify({ portalOrigin: PUBLIC_ORIGIN, replace }),
        },
      ), "tnt_manifest");
      const { state } = await start.json() as { state: string };
      const callbackUrl = `${PUBLIC_ORIGIN}/api/integrations/github-manifest/callback?state=${encodeURIComponent(state)}&code=conversion-code`;
      const concurrent = await Promise.all([integration.callback(new Request(callbackUrl)), integration.callback(new Request(callbackUrl))]);
      const replay = await integration.callback(new Request(callbackUrl));
      const responses = [...concurrent, replay];
      const location = responses.find((response) => response.status === 303)?.headers.get("location");
      committedSlug = location ? new URL(location).pathname.split("/")[2] ?? null : null;
      return responses.map((response) => response.status).sort();
    }
    let committedSlug: string | null = null;

    expect(await callbackStatuses(false)).toEqual([303, 400, 400]);
    expect(await callbackStatuses(true)).toEqual([303, 400, 400]);

    const rows = await db.select().from(schema.credential).where(eq(schema.credential.tenantId, "tnt_manifest"));
    expect(rows.map((row) => row.name).sort()).toEqual(["github", "github-app", "github-hook"]);
    expect(rows.find((row) => row.name === "github")?.metadata).toEqual({ appSlug: committedSlug });
    // The key is moved off the credential workflows bind, which holds no token until the App is installed.
    async function secretOf(name: string): Promise<string> {
      const row = rows.find((candidate) => candidate.name === name)!;
      return cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
    }
    const committed = committedSlug!.slice("app-".length);
    expect(JSON.parse(await secretOf("github-app"))).toEqual({ appId: committed, privateKey: `key-${committed}` });
    expect(await secretOf("github")).toBe("");
  } finally {
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
