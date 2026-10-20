// Connects an existing GitHub App: GitHub confirms the key and names the App,
// and the key and the token minted from it are written together, so the App JSON
// never lands in the credential workflows bind.
import { and, eq } from "drizzle-orm";
import { type } from "arktype";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord, errorText } from "@corbits/common";
import type { Member } from "../integrations/app.js";
import { grantAdminGithub } from "./admin-github-grant.js";
import { GITHUB_CREDENTIAL, lockedCredential, lockGithubCredentials, storeAppKey } from "./app-key.js";
import { ensureTriageRole } from "./automation.js";
import type { GithubTokenRenewal, IssuedApp } from "./installation-token.js";
import { validGithubProvider } from "./manifest.js";
import { failure } from "./portal-credential.js";

export const GITHUB_APP_PATH = "/api/integrations/github-app";

export const AppBody = type({ appId: /^\d+$/, privateKey: "string > 0" });
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
      await storeAppKey(tx, cipher, { tenantId, providerId, appJson });
      const current = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      const id = current?.id ?? generateId("credential");
      const stamp = new Date();
      const values = {
        secret: await cipher.encrypt(issued.token?.token ?? "", credentialAad(id, "secret")),
        expiresAt: issued.token ? new Date(issued.token.expiresAt) : stamp,
        metadata: { ...asRecord(current?.metadata), appSlug: issued.slug },
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

  return async function connectGithubApp(body: typeof AppBody.infer, { tenantId, principalId }: Member): Promise<Response> {
    const current = await db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_CREDENTIAL)) });
    const allowed = current
      ? await deps.authorize(principalId, tenantId, `credential:${current.id}`, "manage")
      : await deps.authorize(principalId, tenantId, "credential:*", "create");
    if (!allowed) return failure(403, "forbidden", "You do not have permission to connect the GitHub App.");
    const githubProvider = await db.query.provider.findFirst({ where: and(eq(provider.tenantId, tenantId), eq(provider.name, "github")) });
    if (!githubProvider || !validGithubProvider(githubProvider, deps.githubApiOrigin)) return failure(409, "github_provider_missing", "The workspace has no GitHub provider for this hub's GitHub.");
    const appJson = JSON.stringify({ appId: body.appId, privateKey: body.privateKey.trim() });
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
