// Requires PostgreSQL at TEST_DB. A fake GitHub accepts only JWTs the App's key signed.
import { expect, test } from "bun:test";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { buildCredentialDelivery, createDB, dropSchema, runMigrations, schema } from "@intx/db";
import { credentialAad } from "@intx/types";
import type { CredentialDelivery } from "@intx/types/credential-delivery";
import { credentialBindingsFor } from "@corbits/triage-workflows/agents";
import { createGithubTokenRenewal } from "./installation-token.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_token";
const LISTENER = "run_listener@token.test";

function signedBy(publicKey: string, authorization: string | null): boolean {
  const [header, payload, signature] = (authorization ?? "").replace(/^Bearer /, "").split(".");
  return signature !== undefined && createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url");
}

function noLog(): void {}

test("PostgreSQL: the App key moves to the hub on boot, each renewed token reaches the running deployments holding it, and no deployment is given the key", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const appJson = JSON.stringify({ appId: "1", privateKey });
  let minted = 0;
  async function github(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (!signedBy(publicKey, req.headers.get("authorization"))) return new Response(null, { status: 401 });
    if (pathname === "/app/installations") {
      return Response.json([{ id: 7, account: { login: "acme" }, html_url: "https://github.com/settings/installations/7", repository_selection: "all", suspended_at: null }]);
    }
    if (req.method === "POST" && pathname === "/app/installations/7/access_tokens") {
      minted += 1;
      return Response.json({ token: `ghs_${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return new Response(null, { status: 404 });
  }
  const server = Bun.serve({ port: 0, fetch: github });
  const origin = server.url.origin;
  const testSchema = `corbits_token_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const { db } = handle;
    const cipher = createEnvKeyCredentialCipher(randomBytes(32));
    await db.insert(schema.tenant).values({ id: TENANT, name: "Token", slug: "token", domain: "token.test" });
    await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: origin });
    // A workspace connected before this change: the App JSON is in the credential workflows bind.
    await db.insert(schema.credential).values({
      id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
      secret: await cipher.encrypt(appJson, credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "triage" },
    });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage-github" });
    await db.insert(schema.workflowRun).values([
      { id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed", address: LISTENER, credentialRefs: { credentialIds: ["crd_github"], bindings: [{ handle: "github", credentialId: "crd_github", consumer: "action:facts" }] } },
      { id: "run_other", anchorRunId: "run_other", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed", address: "run_other@token.test", credentialRefs: { credentialIds: [], bindings: [] } },
    ]);

    const sent: Array<{ address: string; delivery: CredentialDelivery }> = [];
    const router = {
      async sendCredentialsUpdate(address: string, delivery: CredentialDelivery) {
        sent.push({ address, delivery });
      },
    };
    const renewal = createGithubTokenRenewal({ db, cipher, githubApiOrigin: origin, router, log: noLog });
    async function secretOf(name: string): Promise<string> {
      const row = (await db.query.credential.findFirst({ where: and(eq(schema.credential.tenantId, TENANT), eq(schema.credential.name, name)) }))!;
      return cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
    }
    function pushed() {
      return sent.map(({ address, delivery }) => ({ address, secrets: delivery.materials.map((material) => material.secret) }));
    }

    expect(await renewal.renewAll()).toEqual({ retry: false });
    expect(await secretOf("github-app")).toBe(appJson);
    expect(await secretOf("github")).toBe("ghs_1");
    expect(pushed()).toEqual([{ address: LISTENER, secrets: ["ghs_1"] }]);

    const launch = await buildCredentialDelivery({ db, tenantId: TENANT, bindings: credentialBindingsFor(["github"]), creatorPrincipalId: null, invokerPrincipalId: null, credentialCipher: cipher });
    if (!launch.ok) throw new Error(`launch delivery failed: ${JSON.stringify(launch.reason)}`);
    expect(launch.delivery?.materials.map((material) => material.secret)).toEqual(["ghs_1"]);

    expect(await renewal.renewAll()).toEqual({ retry: false });
    expect(pushed().at(-1)).toEqual({ address: LISTENER, secrets: ["ghs_2"] });

    // A worker is deployed with a token that has most of its hour left as it is.
    await renewal.ensure(TENANT);
    expect(minted).toBe(2);

    // Saving the App again through the portal's form writes App JSON to the bound credential; the next worker moves it first.
    await db.update(schema.credential).set({ secret: await cipher.encrypt(appJson, credentialAad("crd_github", "secret")) }).where(eq(schema.credential.id, "crd_github"));
    await renewal.ensure(TENANT);
    expect(await secretOf("github")).toBe("ghs_3");
    expect(pushed().at(-1)).toEqual({ address: LISTENER, secrets: ["ghs_3"] });
    expect(JSON.stringify([sent, launch])).not.toContain("PRIVATE KEY");
  } finally {
    server.stop(true);
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}, 120_000);
