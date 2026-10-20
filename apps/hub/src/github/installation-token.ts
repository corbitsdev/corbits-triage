// Keeps each workspace's `github` credential holding a live installation token,
// minted on the hub from the App key, and pushes each new one to the running
// deployments that hold the credential: a stock secret update alone reaches them
// only when their sidecar reconnects.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { pushCredentialReconcile } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord, errorText } from "@corbits/common";
import { json, listInstallations, type GithubInstallation } from "@corbits/github-reads";
import { decryptSecret, GITHUB_APP_KEY_CREDENTIAL, GITHUB_CREDENTIAL, githubAppKey, lockedCredential, lockGithubCredentials } from "./app-key.js";
import { tenantConfigOf } from "./bridge.js";
import { createGithubAppCredentialFetch, isGithubAppJson, mintInstallationToken } from "./github-app-credential-adapter.js";
import { activeCredential, appGithubFetch } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";

/** Installation tokens last an hour. */
export const GITHUB_TOKEN_RENEW_MS = 45 * 60_000;
/** A worker is deployed with the token it reads, so one with less left than this is renewed first. */
const MIN_TOKEN_LIFE_MS = 15 * 60_000;

export type InstallationToken = { token: string; expiresAt: number };
/** What GitHub says of an App: its slug, and a token for the workspace's installation once it is installed. */
export type IssuedApp = { slug: string; token?: InstallationToken };

/** The workspace's one installation: the one its repositories came from, else the oldest. */
export function primaryInstallation<T extends Pick<GithubInstallation, "id">>(active: readonly T[], recorded: ReadonlySet<number>): T | undefined {
  const oldestFirst = [...active].sort((a, b) => a.id - b.id);
  return oldestFirst.find((installation) => recorded.has(installation.id)) ?? oldestFirst[0];
}

/** The installations the workspace's GitHub repositories were added from. */
export async function recordedInstallations(db: DB["db"], tenantId: string): Promise<Set<number>> {
  const records = repoRecords(triageNs(await tenantConfigOf({ db }, tenantId)));
  return new Set(records.flatMap((record) => (sourceOf(record) === "github" && record.installationId !== undefined ? [record.installationId] : [])));
}

export type GithubTokenDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  githubApiOrigin: string;
  router: Parameters<typeof pushCredentialReconcile>[1];
  log: (entry: Record<string, unknown>) => void;
  fetch?: typeof fetch;
};

export function createGithubTokenRenewal(deps: GithubTokenDeps) {
  const transport = { apiOrigin: deps.githubApiOrigin, ...(deps.fetch && { fetch: deps.fetch }) };
  const appFetch = createGithubAppCredentialFetch(transport);
  const { credential, workflowRun } = schema;

  async function issue(tenantId: string, appJson: string): Promise<IssuedApp> {
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
    const app = await json(gh, "/app") as { slug?: unknown };
    if (typeof app.slug !== "string" || app.slug === "") throw new Error("github returned an invalid App slug");
    const active = (await listInstallations(gh)).filter((installation) => !installation.suspended);
    const primary = primaryInstallation(active, await recordedInstallations(deps.db, tenantId));
    if (!primary) return { slug: app.slug };
    return { slug: app.slug, token: await mintInstallationToken(transport, appJson, primary.id) };
  }

  async function holders(tenantId: string, credentialId: string): Promise<string[]> {
    const runs = await deps.db.query.workflowRun.findMany({
      where: and(eq(workflowRun.tenantId, tenantId), inArray(workflowRun.status, [...schema.liveWorkflowRunStatuses]), isNotNull(workflowRun.address), isNotNull(workflowRun.credentialRefs)),
      columns: { address: true, credentialRefs: true },
    });
    return runs.flatMap((run) => (run.address !== null && run.credentialRefs?.credentialIds.includes(credentialId) ? [run.address] : []));
  }

  /** Sends the `github` credential's current token to each running deployment holding it. */
  async function push(tenantId: string): Promise<void> {
    const github = await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (!github) return;
    for (const address of await holders(tenantId, github.id)) await pushCredentialReconcile(deps.db, deps.router, address, deps.cipher);
  }

  /** Stores what was issued for `appJson`, unless the App was replaced while it was minted: the replacement wrote its own. */
  async function store(tenantId: string, appJson: string, issued: IssuedApp): Promise<boolean> {
    return deps.db.transaction(async function storeToken(tx) {
      await lockGithubCredentials(tx, tenantId);
      const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      const key = await lockedCredential(tx, tenantId, GITHUB_APP_KEY_CREDENTIAL);
      if (github?.status !== "active" || key?.status !== "active") return false;
      if ((await decryptSecret(deps.cipher, key)) !== appJson || isGithubAppJson(await decryptSecret(deps.cipher, github))) return false;
      const metadata = { ...asRecord(github.metadata), appSlug: issued.slug };
      const token = issued.token && { secret: await deps.cipher.encrypt(issued.token.token, credentialAad(github.id, "secret")), expiresAt: new Date(issued.token.expiresAt) };
      // updatedAt stays: a GitHub setup that replaces the App refuses to commit once it moved, and a renewal replaces nothing.
      await tx.update(credential).set({ metadata, ...token }).where(eq(credential.id, github.id));
      return token !== undefined;
    });
  }

  async function renewWith(tenantId: string, appJson: string): Promise<void> {
    const issued = await issue(tenantId, appJson);
    if (!(await store(tenantId, appJson, issued)) || !issued.token) return;
    await push(tenantId);
    deps.log({ level: "info", msg: "github_token_renewed", tenantId, expiresAt: new Date(issued.token.expiresAt).toISOString() });
  }

  async function renew(tenantId: string): Promise<void> {
    await renewWith(tenantId, await githubAppKey(deps, tenantId));
  }

  /** Renews the token unless it has long enough left; reading the key first moves one a stock write left, which leaves no token. */
  async function ensure(tenantId: string): Promise<void> {
    if (!(await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL))) return;
    const appJson = await githubAppKey(deps, tenantId);
    const github = await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (github?.expiresAt && github.expiresAt.getTime() - Date.now() > MIN_TOKEN_LIFE_MS) return;
    await renewWith(tenantId, appJson);
  }

  /** A key whose `github` credential was removed through the stock route goes with it. */
  async function dropOrphanKey(tenantId: string): Promise<void> {
    await deps.db.transaction(async function drop(tx) {
      await lockGithubCredentials(tx, tenantId);
      if (await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL)) return;
      await tx.delete(credential).where(and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL)));
      deps.log({ level: "info", msg: "github_app_key_dropped", tenantId });
    });
  }

  /** Every workspace with GitHub connected; a workspace that failed asks for an early retry. */
  async function renewAll(): Promise<{ retry: boolean }> {
    const rows = await deps.db.select({ tenantId: credential.tenantId, name: credential.name }).from(credential)
      .where(and(inArray(credential.name, [GITHUB_CREDENTIAL, GITHUB_APP_KEY_CREDENTIAL]), eq(credential.status, "active")));
    const connected = new Set(rows.flatMap((row) => (row.name === GITHUB_CREDENTIAL ? [row.tenantId] : [])));
    let retry = false;
    for (const { tenantId, name } of rows) {
      try {
        if (name === GITHUB_CREDENTIAL) await renew(tenantId);
        else if (!connected.has(tenantId)) await dropOrphanKey(tenantId);
      } catch (err) {
        retry = true;
        deps.log({ level: "error", msg: "github_token_renew_failed", tenantId, error: errorText(err) });
      }
    }
    return { retry };
  }

  return { issue, push, renew, ensure, renewAll };
}

export type GithubTokenRenewal = ReturnType<typeof createGithubTokenRenewal>;
