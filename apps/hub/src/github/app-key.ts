// The GitHub App's private key is read only on the hub, from a credential no
// workflow binds; the `github` credential workflows bind holds an installation token.
import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord } from "@corbits/common";
import { isGithubAppJson } from "./github-app-credential-adapter.js";

export const GITHUB_CREDENTIAL = "github";
export const GITHUB_APP_KEY_CREDENTIAL = "github-app";

const { credential } = schema;

export type AppKeyDeps = { db: DB["db"]; cipher: CredentialCipher };

/** The bot account the App acts as, named by the slug a connection stores on the `github` credential. */
export function githubAppLogin(row: { metadata: unknown }): string {
  const slug = asRecord(row.metadata)?.["appSlug"];
  if (typeof slug !== "string" || slug === "") throw new Error("github app credential has no appSlug");
  return `${slug}[bot]`;
}

function decrypt(cipher: CredentialCipher, row: { id: string; secret: string }): Promise<string> {
  return cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
}

/**
 * A connection writes App JSON to the `github` credential, through the manifest or the portal's form, so it is moved
 * to the hub-only credential; the `github` credential holds no token until one is minted.
 */
async function moveAppKey({ db, cipher }: AppKeyDeps, tenantId: string): Promise<void> {
  await db.transaction(async function move(tx) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);
    const [github] = await tx.select().from(credential).where(and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_CREDENTIAL))).for("update");
    if (!github) return;
    const appJson = await decrypt(cipher, github);
    if (!isGithubAppJson(appJson)) return;
    const [held] = await tx.select().from(credential).where(and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL))).for("update");
    const id = held?.id ?? generateId("credential");
    const secret = await cipher.encrypt(appJson, credentialAad(id, "secret"));
    const stamp = new Date();
    if (held) {
      await tx.update(credential).set({ secret, status: "active", updatedAt: stamp }).where(eq(credential.id, id));
    } else {
      await tx.insert(credential).values({
        id, tenantId, principalId: null, providerId: github.providerId, oauthClientId: null, name: GITHUB_APP_KEY_CREDENTIAL,
        type: "api_key", description: null, secret, refreshSecret: null, scopes: null, expiresAt: null,
        status: "active", metadata: null, createdAt: stamp, updatedAt: stamp,
      });
    }
    const noToken = await cipher.encrypt("", credentialAad(github.id, "secret"));
    await tx.update(credential).set({ secret: noToken, expiresAt: stamp, updatedAt: stamp }).where(eq(credential.id, github.id));
  });
}

/** The workspace's App JSON; called only once its `github` credential exists. */
export async function githubAppKey(deps: AppKeyDeps, tenantId: string): Promise<string> {
  const github = await deps.db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_CREDENTIAL)) });
  if (github && isGithubAppJson(await decrypt(deps.cipher, github))) await moveAppKey(deps, tenantId);
  const key = await deps.db.query.credential.findFirst({
    where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL), eq(credential.status, "active")),
  });
  if (!key) throw new Error("the workspace has no GitHub App key");
  return decrypt(deps.cipher, key);
}
