// Requires PostgreSQL at TEST_DB. A fake GitHub accepts only JWTs signed by a registered App's key.
import { expect, test } from "bun:test";
import { createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import { buildCredentialDelivery, createDB, dropSchema, runMigrations, schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import type { CredentialDelivery } from "@intx/types/credential-delivery";
import { credentialBindingsFor } from "@corbits/triage-workflows/agents";
import { createGithubAppConnection } from "./app-connection.js";
import { withAppLogin } from "./bridge.js";
import { createGithubTokenRenewal } from "./installation-token.js";

const TEST_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_token";
const LISTENER = "run_listener@token.test";

type App = { appId: string; json: string; publicKey: string; installations: number[] };

function app(appId: string, installations: number[]): App {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  return { appId, json: JSON.stringify({ appId, privateKey: privateKey.trim() }), publicKey, installations };
}

/** GitHub as the hub sees it: each App's slug, installations and installation tokens, named `ghs_<appId>_<n>`. */
function fakeGithub(apps: App[]) {
  let minted = 0;
  const hooks = { down: false, async onMint(): Promise<void> {} };
  function signer(authorization: string | null): App | undefined {
    const [header, payload, signature] = (authorization ?? "").replace(/^Bearer /, "").split(".");
    if (!payload || !signature) return undefined;
    const { iss } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string };
    const found = apps.find((candidate) => candidate.appId === iss);
    return found && createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(found.publicKey, signature, "base64url") ? found : undefined;
  }
  async function github(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (hooks.down) return new Response(null, { status: 503 });
    const signed = signer(req.headers.get("authorization"));
    if (!signed) return new Response(null, { status: 401 });
    if (pathname === "/app") return Response.json({ slug: `app-${signed.appId}` });
    if (pathname === "/app/installations") {
      return Response.json(signed.installations.map((id) => ({ id, account: { login: `acct-${id}` }, html_url: `https://github.com/settings/installations/${id}`, repository_selection: "all", suspended_at: null })));
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(pathname);
    if (req.method === "POST" && mint && signed.installations.includes(Number(mint[1]))) {
      await hooks.onMint();
      minted += 1;
      return Response.json({ token: `ghs_${signed.appId}_${mint[1]}_${minted}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    return new Response(null, { status: 404 });
  }
  return { server: Bun.serve({ port: 0, fetch: github }), hooks, minted: () => minted };
}

function noLog(): void {}

async function allowAll(): Promise<boolean> {
  return true;
}

async function withWorkspace(apps: App[], body: (env: { db: DB["db"]; cipher: CredentialCipher; origin: string; github: ReturnType<typeof fakeGithub> }) => Promise<void>): Promise<void> {
  const github = fakeGithub(apps);
  const origin = github.server.url.origin;
  const testSchema = `corbits_token_${randomBytes(6).toString("hex")}`;
  let handle: ReturnType<typeof createDB> | undefined;
  try {
    await runMigrations(TEST_DB, { schema: testSchema });
    handle = createDB({ ...TEST_DB, schema: testSchema });
    const { db } = handle;
    await db.insert(schema.tenant).values({ id: TENANT, name: "Token", slug: "token", domain: "token.test" });
    await db.insert(schema.provider).values({ id: "prv_github", tenantId: TENANT, name: "github", plugin: "http", apiBaseUrl: origin });
    await body({ db, cipher: createEnvKeyCredentialCipher(randomBytes(32)), origin, github });
  } finally {
    github.server.stop(true);
    await handle?.close();
    await dropSchema(TEST_DB, { schema: testSchema });
  }
}

function deliveries() {
  const sent: Array<{ address: string; delivery: CredentialDelivery }> = [];
  const router = {
    async sendCredentialsUpdate(address: string, delivery: CredentialDelivery) {
      sent.push({ address, delivery });
    },
  };
  function pushed() {
    return sent.map(({ address, delivery }) => ({ address, secrets: delivery.materials.map((material) => material.secret) }));
  }
  return { sent, router, pushed };
}

function secrets(db: DB["db"], cipher: CredentialCipher) {
  return async function secretOf(name: string): Promise<string> {
    const row = (await db.query.credential.findFirst({ where: and(eq(schema.credential.tenantId, TENANT), eq(schema.credential.name, name)) }))!;
    return cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
  };
}

async function slugOf(db: DB["db"]): Promise<unknown> {
  const row = await db.query.credential.findFirst({ where: and(eq(schema.credential.tenantId, TENANT), eq(schema.credential.name, "github")) });
  return (row?.metadata as { appSlug?: unknown } | null)?.appSlug;
}

test("PostgreSQL: the App key moves to the hub on boot, each renewed token reaches the running deployments holding it, and no deployment is given the key", async () => {
  const first = app("1", [7]);
  const replacement = app("2", [7]);
  await withWorkspace([first, replacement], async function bootAndRenew({ db, cipher, origin, github }) {
    // A workspace connected before this change: the App JSON is in the credential workflows bind, under a typed slug.
    await db.insert(schema.credential).values({
      id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
      secret: await cipher.encrypt(first.json, credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "typed" },
    });
    await db.insert(schema.workflowDefinition).values({ id: "wfd_triage", tenantId: TENANT, name: "pr-triage-github" });
    await db.insert(schema.workflowRun).values([
      { id: "run_listener", anchorRunId: "run_listener", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed", address: LISTENER, credentialRefs: { credentialIds: ["crd_github"], bindings: [{ handle: "github", credentialId: "crd_github", consumer: "action:facts" }] } },
      { id: "run_other", anchorRunId: "run_other", definitionId: "wfd_triage", tenantId: TENANT, status: "deployed", address: "run_other@token.test", credentialRefs: { credentialIds: [], bindings: [] } },
    ]);
    const { sent, router, pushed } = deliveries();
    const renewal = createGithubTokenRenewal({ db, cipher, githubApiOrigin: origin, router, log: noLog });
    const secretOf = secrets(db, cipher);

    expect(await renewal.renewAll()).toEqual({ retry: false });
    expect(await secretOf("github-app")).toBe(first.json);
    expect(await secretOf("github")).toBe("ghs_1_7_1");
    expect(await slugOf(db)).toBe("app-1");
    expect(pushed()).toEqual([{ address: LISTENER, secrets: ["ghs_1_7_1"] }]);

    const launch = await buildCredentialDelivery({ db, tenantId: TENANT, bindings: credentialBindingsFor(["github"]), creatorPrincipalId: null, invokerPrincipalId: null, credentialCipher: cipher });
    if (!launch.ok) throw new Error(`launch delivery failed: ${JSON.stringify(launch.reason)}`);
    expect(launch.delivery?.materials.map((material) => material.secret)).toEqual(["ghs_1_7_1"]);

    expect(await renewal.renewAll()).toEqual({ retry: false });
    expect(pushed().at(-1)).toEqual({ address: LISTENER, secrets: ["ghs_1_7_2"] });

    // A worker is deployed with a token that has most of its hour left as it is.
    await renewal.ensure(TENANT);
    expect(github.minted()).toBe(2);

    // A stock credential write replaces the App while a renewal mints from the old key: the renewal does not overwrite it.
    github.hooks.onMint = async function stockWriteSavesReplacement() {
      await db.update(schema.credential).set({ secret: await cipher.encrypt(replacement.json, credentialAad("crd_github", "secret")) }).where(eq(schema.credential.id, "crd_github"));
    };
    await renewal.renew(TENANT);
    github.hooks.onMint = async function quiet() {};
    expect(await secretOf("github")).toBe(replacement.json);
    expect(pushed()).toHaveLength(2);

    // The next worker moves the replacement off the bound credential and mints from it.
    await renewal.ensure(TENANT);
    expect(await secretOf("github-app")).toBe(replacement.json);
    expect(await secretOf("github")).toBe("ghs_2_7_4");
    expect(pushed().at(-1)).toEqual({ address: LISTENER, secrets: ["ghs_2_7_4"] });
    expect(JSON.stringify([sent, launch])).not.toContain("PRIVATE KEY");

    // GitHub down: the reason is kept, and a token past its expiry is no longer resolved for a launch.
    async function githubRow() {
      return (await db.query.credential.findFirst({ where: eq(schema.credential.id, "crd_github") }))!;
    }
    function launchable() {
      return buildCredentialDelivery({ db, tenantId: TENANT, bindings: credentialBindingsFor(["github"]), creatorPrincipalId: null, invokerPrincipalId: null, credentialCipher: cipher });
    }
    github.hooks.down = true;
    expect(await renewal.renewAll()).toEqual({ retry: true });
    expect(await githubRow()).toMatchObject({ status: "active", metadata: { appSlug: "app-2", tokenError: expect.stringContaining("503") } });
    await db.update(schema.credential).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.credential.id, "crd_github"));
    await expect(renewal.ensure(TENANT)).rejects.toThrow("503");
    expect((await githubRow()).status).toBe("expired");
    expect((await launchable()).ok).toBe(false);

    github.hooks.down = false;
    await renewal.ensure(TENANT);
    expect(await githubRow()).toMatchObject({ status: "active", metadata: { appSlug: "app-2" } });
    expect((await githubRow()).metadata).not.toHaveProperty("tokenError");
    expect((await launchable()).ok).toBe(true);
  });
}, 120_000);

test("PostgreSQL: connecting an App writes its key and token together, a renewal of the replaced App does not overwrite them, and one installation is used", async () => {
  const first = app("1", [7]);
  // Installed on two accounts: the workspace uses the oldest installation.
  const replacement = app("2", [9, 8]);
  await withWorkspace([first, replacement], async function connectAndReplace({ db, cipher, origin, github }) {
    const { router, pushed } = deliveries();
    const renewal = createGithubTokenRenewal({ db, cipher, githubApiOrigin: origin, router, log: noLog });
    const connect = createGithubAppConnection({ db, cipher, authorize: allowAll, githubApiOrigin: origin, renewal });
    const member = { tenantId: TENANT, principalId: "prn_admin" };
    const secretOf = secrets(db, cipher);

    const refused = await connect({ appId: "3", privateKey: JSON.parse(first.json).privateKey }, member);
    expect(refused.status).toBe(400);

    const connected = await connect({ appId: "1", privateKey: JSON.parse(first.json).privateKey }, member);
    expect(await connected.json()).toEqual({ appSlug: "app-1" });
    expect(await secretOf("github-app")).toBe(first.json);
    expect(await secretOf("github")).toBe("ghs_1_7_1");

    // The App is replaced while the renewal mints from the first one.
    github.hooks.onMint = async function replaceDuringMint() {
      github.hooks.onMint = async function quiet() {};
      expect((await connect({ appId: "2", privateKey: JSON.parse(replacement.json).privateKey }, member)).status).toBe(200);
    };
    await renewal.renew(TENANT);
    expect(await secretOf("github-app")).toBe(replacement.json);
    expect(await secretOf("github")).toBe("ghs_2_8_2");
    expect(await slugOf(db)).toBe("app-2");
    expect(pushed()).toEqual([]);
  });
}, 120_000);

test("PostgreSQL: a child workspace inheriting its parent's App gets the parent's login on its mail and the parent's renewed token on its deployment", async () => {
  const parentApp = app("1", [7]);
  await withWorkspace([parentApp], async function inherit({ db, cipher, origin }) {
    await db.insert(schema.credential).values({
      id: "crd_github", tenantId: TENANT, principalId: null, providerId: "prv_github", oauthClientId: null, name: "github", type: "api_key",
      secret: await cipher.encrypt(parentApp.json, credentialAad("crd_github", "secret")), status: "active", metadata: { appSlug: "app-1" },
    });
    await db.insert(schema.tenant).values([
      { id: "tnt_child", name: "Child", slug: "child", domain: "child.test", parentId: TENANT },
      { id: "tnt_none", name: "None", slug: "none", domain: "none.test" },
    ]);
    await db.insert(schema.workflowDefinition).values({ id: "wfd_child", tenantId: "tnt_child", name: "pr-triage-github" });
    await db.insert(schema.workflowRun).values({
      id: "run_child", anchorRunId: "run_child", definitionId: "wfd_child", tenantId: "tnt_child", status: "deployed", address: "run_child@child.test",
      credentialRefs: { credentialIds: ["crd_github"], bindings: [{ handle: "github", credentialId: "crd_github", consumer: "action:facts" }] },
    });
    const { router, pushed } = deliveries();
    const renewal = createGithubTokenRenewal({ db, cipher, githubApiOrigin: origin, router, log: noLog });

    expect(await withAppLogin(db, "tnt_child", { kind: "pr" })).toEqual({ kind: "pr", appLogin: "app-1[bot]" });
    await expect(withAppLogin(db, "tnt_none", { kind: "pr" })).rejects.toThrow("github app credential is missing");

    expect(await renewal.renewAll()).toEqual({ retry: false });
    expect(pushed()).toEqual([{ address: "run_child@child.test", secrets: ["ghs_1_7_1"] }]);
  });
});
