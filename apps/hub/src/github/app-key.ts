// The GitHub App's private key is read only on the hub, from a credential no
// workflow binds; the `github` credential workflows bind holds an installation token.
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord } from "@corbits/common";
import type { Tx } from "./admin-github-grant.js";
import { isGithubAppJson } from "./github-app-credential-adapter.js";

export const GITHUB_CREDENTIAL = "github";
export const GITHUB_APP_KEY_CREDENTIAL = "github-app";
/** The key's provider has no API origin, so stock refuses to deliver the key to any sidecar (`no_origin`). */
const GITHUB_APP_KEY_PROVIDER = "github-app";

const { credential, provider } = schema;

export type AppKeyDeps = { db: DB["db"]; cipher: CredentialCipher };

/** The bot account the App acts as, named by the slug GitHub gave for it, stored on the `github` credential. */
export function githubAppLogin(row: { metadata: unknown }): string {
  const slug = asRecord(row.metadata)?.["appSlug"];
  if (typeof slug !== "string" || slug === "") throw new Error("github app credential has no appSlug");
  return `${slug}[bot]`;
}

/** Why the last renewal of the `github` credential's token failed, kept on its metadata for the portal. */
export const TOKEN_ERROR = "tokenError";

/** The `github` credential's metadata for the App GitHub names `slug`, once a renewal has worked. */
export function renewedMetadata(metadata: unknown, slug: string): Record<string, unknown> {
  const kept = Object.entries(asRecord(metadata) ?? {}).filter(([key]) => key !== TOKEN_ERROR);
  return { ...Object.fromEntries(kept), appSlug: slug };
}

export function decryptSecret(cipher: CredentialCipher, row: { id: string; secret: string }): Promise<string> {
  return cipher.decrypt(row.secret, credentialAad(row.id, "secret"));
}

/** Every write to the workspace's GitHub credentials holds this, so a key and the token minted from it change together. */
export async function lockGithubCredentials(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`);
}

export async function lockedCredential(tx: Tx, tenantId: string, name: string) {
  const [row] = await tx.select().from(credential).where(and(eq(credential.tenantId, tenantId), eq(credential.name, name))).for("update");
  return row;
}

async function keyProviderId(tx: Tx, tenantId: string): Promise<string> {
  await tx.insert(provider).values({ id: generateId("provider"), tenantId, name: GITHUB_APP_KEY_PROVIDER, plugin: "http", apiBaseUrl: null }).onConflictDoNothing();
  const [row] = await tx.select({ id: provider.id }).from(provider).where(and(eq(provider.tenantId, tenantId), eq(provider.name, GITHUB_APP_KEY_PROVIDER)));
  if (!row) throw new Error("the GitHub App key provider is missing");
  return row.id;
}

/** Writes the App JSON to the hub-only credential; the caller holds the lock. */
export async function storeAppKey(tx: Tx, cipher: CredentialCipher, { tenantId, appJson }: { tenantId: string; appJson: string }): Promise<void> {
  const held = await lockedCredential(tx, tenantId, GITHUB_APP_KEY_CREDENTIAL);
  const id = held?.id ?? generateId("credential");
  const secret = await cipher.encrypt(appJson, credentialAad(id, "secret"));
  const providerId = await keyProviderId(tx, tenantId);
  const stamp = new Date();
  if (held) {
    await tx.update(credential).set({ secret, providerId, status: "active", updatedAt: stamp }).where(eq(credential.id, id));
    return;
  }
  await tx.insert(credential).values({
    id, tenantId, principalId: null, providerId, oauthClientId: null, name: GITHUB_APP_KEY_CREDENTIAL,
    type: "api_key", description: null, secret, refreshSecret: null, scopes: null, expiresAt: null,
    status: "active", metadata: null, createdAt: stamp, updatedAt: stamp,
  });
}

/**
 * App JSON a stock credential write left in the `github` credential moves to the hub-only one, leaving no token; a key
 * stored before it had its own provider is moved onto it. Whether App JSON was moved, so its holders are sent the blank.
 */
export async function moveAppKey({ db, cipher }: AppKeyDeps, tenantId: string): Promise<boolean> {
  return db.transaction(async function move(tx) {
    await lockGithubCredentials(tx, tenantId);
    const key = await lockedCredential(tx, tenantId, GITHUB_APP_KEY_CREDENTIAL);
    if (key) await tx.update(credential).set({ providerId: await keyProviderId(tx, tenantId) }).where(eq(credential.id, key.id));
    const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
    if (!github) return false;
    const appJson = await decryptSecret(cipher, github);
    if (!isGithubAppJson(appJson)) return false;
    await storeAppKey(tx, cipher, { tenantId, appJson });
    const stamp = new Date();
    const noToken = await cipher.encrypt("", credentialAad(github.id, "secret"));
    await tx.update(credential).set({ secret: noToken, expiresAt: stamp, updatedAt: stamp }).where(eq(credential.id, github.id));
    return true;
  });
}

const APP_KEY_WRITE_REFUSED = "The GitHub App key is saved through the GitHub App setup, not as the github credential.";

/** A stock credential write (`credentialId` absent for a new one) that would put App JSON where workflows bind it. */
export async function appKeyWriteRefusal(db: DB["db"], tenantId: string, credentialId: string | undefined, req: Request): Promise<Response | undefined> {
  let fields: Record<string, unknown> | undefined;
  try {
    fields = asRecord(await req.clone().json());
  } catch {
    return undefined;
  }
  const secret = fields?.["secret"];
  if (typeof secret !== "string" || !isGithubAppJson(secret)) return undefined;
  const existing = credentialId === undefined ? undefined : await db.query.credential.findFirst({ where: and(eq(credential.id, credentialId), eq(credential.tenantId, tenantId)) });
  const name = typeof fields?.["name"] === "string" ? fields["name"] : existing?.name;
  if (name !== GITHUB_CREDENTIAL) return undefined;
  return Response.json({ error: { code: "github_app_key_write", message: APP_KEY_WRITE_REFUSED } }, { status: 400 });
}

/** Every workspace holding a GitHub credential or App key, so each is checked before any sidecar is restored. */
export async function githubTenants(db: DB["db"]): Promise<string[]> {
  const rows = await db.selectDistinct({ tenantId: credential.tenantId }).from(credential).where(inArray(credential.name, [GITHUB_CREDENTIAL, GITHUB_APP_KEY_CREDENTIAL]));
  return rows.map((row) => row.tenantId);
}

/** The workspace's App JSON; called only once its `github` credential exists. */
export async function githubAppKey(deps: AppKeyDeps, tenantId: string): Promise<string> {
  const github = await deps.db.query.credential.findFirst({ where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_CREDENTIAL)) });
  if (github && isGithubAppJson(await decryptSecret(deps.cipher, github))) await moveAppKey(deps, tenantId);
  const key = await deps.db.query.credential.findFirst({
    where: and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL), eq(credential.status, "active")),
  });
  if (!key) throw new Error("the workspace has no GitHub App key");
  return decryptSecret(deps.cipher, key);
}
