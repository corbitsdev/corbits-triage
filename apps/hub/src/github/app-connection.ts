// Connects an existing GitHub App: GitHub confirms the key and names the App,
// and the key and the token minted from it are written together, so the App JSON
// never lands in the credential workflows bind.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { errorText } from "@corbits/common";
import type { Member } from "../integrations/app.js";
import { grantAdminGithub } from "./admin-github-grant.js";
import { decryptSecret, GITHUB_APP_KEY_CREDENTIAL, GITHUB_CREDENTIAL, lockedCredential, lockGithubCredentials, renewedMetadata, storeAppKey } from "./app-key.js";
import { ensureTriageRole } from "./automation.js";
import type { GithubTokenRenewal, IssuedApp } from "./installation-token.js";
import { validGithubProvider } from "./manifest.js";
import { failure } from "./portal-credential.js";

export const GITHUB_APP_PATH = "/api/integrations/github-app";

export const AppBody = type({ "appId?": /^\d+$/, privateKey: "string > 0", "replace?": "boolean" });
const StoredApp = type({ appId: "string" });
export const AppConnected = type({ appSlug: "string" });

export type GithubAppConnectionDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  authorize: (principalId: string, tenantId: string, resource: string, action: string) => Promise<boolean>;
  githubApiOrigin: string;
  renewal: Pick<GithubTokenRenewal, "issue" | "push">;
};

export function createGithubAppConnection(deps: GithubAppConnectionDeps) {
  const { db, cipher } = deps;
  const { credential, provider } = schema;

  async function store(tenantId: string, providerId: string, appJson: string, issued: IssuedApp): Promise<void> {
    await db.transaction(async function connect(tx) {
      await lockGithubCredentials(tx, tenantId);
      await storeAppKey(tx, cipher, { tenantId, appJson });
      const current = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      const id = current?.id ?? generateId("credential");
      const stamp = new Date();
      const values = {
        secret: await cipher.encrypt(issued.token?.token ?? "", credentialAad(id, "secret")),
        expiresAt: issued.token ? new Date(issued.token.expiresAt) : stamp,
        metadata: renewedMetadata(current?.metadata, issued.slug),
        providerId, status: "active" as const, updatedAt: stamp,
      };
      if (current) {
        await tx.update(credential).set(values).where(eq(credential.id, id));
      } else {
        await tx.insert(credential).values({ ...values, id, tenantId, principalId: null, oauthClientId: null, name: GITHUB_CREDENTIAL, type: "api_key", description: null, refreshSecret: null, scopes: null, createdAt: stamp });
        await grantAdminGithub(tx, tenantId, id, stamp);
      }
      await ensureTriageRole(tx, tenantId, stamp);
    });
  }

  async function storedAppId(tenantId: string): Promise<string | undefined> {
    const key = await db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL)) });
    if (!key) return undefined;
    return StoredApp.assert(JSON.parse(await decryptSecret(cipher, key))).appId;
  }

  return async function connectGithubApp(body: typeof AppBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const current = await db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_CREDENTIAL)) });
    const allowed = current
      ? await deps.authorize(principalId, tenantId, `credential:${current.id}`, "manage")
      : await deps.authorize(principalId, tenantId, "credential:*", "create");
    if (!allowed) return failure(403, "forbidden", "You do not have permission to connect the GitHub App.");
    const githubProvider = await db.query.provider.findFirst({ where: and(eq(provider.tenantId, tenantId), eq(provider.name, "github")) });
    if (!githubProvider || !validGithubProvider(githubProvider, deps.githubApiOrigin)) return failure(409, "github_provider_missing", "The workspace has no GitHub provider for this hub's GitHub.");
    const connectedAppId = await storedAppId(tenantId);
    const appId = body.appId ?? connectedAppId;
    if (appId === undefined) return failure(400, "invalid_request", "Enter the App ID.");
    if (!body.replace && connectedAppId !== undefined && connectedAppId !== appId) {
      return failure(409, "github_app_mismatch", "That App ID is not the connected GitHub App's. To switch to another App, use Create GitHub App.");
    }
    const appJson = JSON.stringify({ appId, privateKey: body.privateKey.trim() });
    let issued: IssuedApp;
    try {
      issued = await deps.renewal.issue(tenantId, appJson);
    } catch (err) {
      return failure(400, "github_app_refused", `GitHub did not accept this App ID and private key: ${errorText(err)}.`);
    }
    await store(tenantId, githubProvider.id, appJson, issued);
    if (issued.token) await deps.renewal.push(tenantId);
    return Response.json({ appSlug: issued.slug });
  };
}
