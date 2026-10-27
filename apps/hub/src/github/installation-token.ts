// Keeps each workspace's `github` credential holding a live installation token,
// and its `github-read` credential one that can only read contents, both minted on
// the hub from the App key, and pushes each new one to the running deployments that
// hold the credential: a stock secret update alone reaches them only when their
// sidecar reconnects.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { pushCredentialReconcile, type RunCredentialsLoader } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord, errorText } from "@corbits/common";
import { json, listInstallations, type GithubInstallation } from "@corbits/github-reads";
import type { Tx } from "./admin-github-grant.js";
import { decryptSecret, GITHUB_APP_KEY_CREDENTIAL, GITHUB_CREDENTIAL, GITHUB_READ_CREDENTIAL, githubAppKey, lockedCredential, lockGithubCredentials, moveAppKey, renewedMetadata, TOKEN_ERROR } from "./app-key.js";
import { tenantConfigOf } from "./bridge.js";
import { createGithubAppCredentialFetch, isGithubAppJson, mintInstallationToken, type TokenScope } from "./github-app-credential-adapter.js";
import { GithubRateLimited } from "./github-usage.js";
import type { ReconcileOutcome } from "./triage-reconciler.js";
import { appGithubFetch, heldCredential } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";

/** Installation tokens last an hour. */
export const GITHUB_TOKEN_RENEW_MS = 45 * 60_000;
/** A full pass falls due a little before the renewal interval fires, so the interval's pass is always full. */
const RETRY_SLACK_MS = 60_000;

export type InstallationToken = { token: string; expiresAt: number };
/**
 * What GitHub says of an App: its slug and, once it is installed, a token for the workspace's installation and a read
 * token for its repositories, or why the read token was refused, which leaves the write token renewed.
 */
export type IssuedApp = { slug: string; token?: InstallationToken; read?: InstallationToken | { error: string } };

const READ_SCOPE = { contents: "read" } as const;

/** The workspace's one installation: the one its repositories came from, else the oldest. */
export function primaryInstallation<T extends Pick<GithubInstallation, "id">>(active: readonly T[], recorded: ReadonlySet<number>): T | undefined {
  const oldestFirst = [...active].sort((a, b) => a.id - b.id);
  return oldestFirst.find((installation) => recorded.has(installation.id)) ?? oldestFirst[0];
}

async function githubRecords(db: DB["db"], tenantId: string): Promise<RepoRecord[]> {
  return repoRecords(triageNs(await tenantConfigOf({ db }, tenantId))).filter((record) => sourceOf(record) === "github");
}

function installationsOf(records: readonly RepoRecord[]): Set<number> {
  return new Set(records.flatMap((record) => (record.installationId === undefined ? [] : [record.installationId])));
}

/** The installations the workspace's GitHub repositories were added from. */
export async function recordedInstallations(db: DB["db"], tenantId: string): Promise<Set<number>> {
  return installationsOf(await githubRecords(db, tenantId));
}

/** The read token covers only the workspace's repositories from the installation, named without their owner as GitHub asks. */
function readScope(records: readonly RepoRecord[], installationId: number): TokenScope | undefined {
  const repositories = records.flatMap((record) => (record.installationId === installationId ? [record.name.slice(record.name.indexOf("/") + 1)] : []));
  return repositories.length === 0 ? undefined : { permissions: READ_SCOPE, repositories };
}

/**
 * Writes the read token, or why it was refused, to `github-read` beside `github`, whose provider it shares; the caller
 * holds the lock. A refusal keeps a token with time left and marks one past its expiry `expired`, so no code review is
 * deployed with it; a first refusal leaves an expired row holding no token, so the portal can say why.
 */
export async function storeReadToken(tx: Tx, cipher: CredentialCipher, github: { tenantId: string; providerId: string }, read: NonNullable<IssuedApp["read"]>): Promise<void> {
  const { credential } = schema;
  const current = await lockedCredential(tx, github.tenantId, GITHUB_READ_CREDENTIAL);
  const id = current?.id ?? generateId("credential");
  const stamp = new Date();
  const live = (current?.expiresAt ?? stamp) > stamp;
  const values = "error" in read
    ? { metadata: { ...asRecord(current?.metadata), [TOKEN_ERROR]: read.error }, ...(!live && { status: "expired" as const }) }
    : { secret: await cipher.encrypt(read.token, credentialAad(id, "secret")), expiresAt: new Date(read.expiresAt), status: "active" as const, metadata: null };
  if (current) {
    await tx.update(credential).set({ ...values, providerId: github.providerId, updatedAt: stamp }).where(eq(credential.id, id));
    return;
  }
  await tx.insert(credential).values({
    secret: await cipher.encrypt("", credentialAad(id, "secret")), expiresAt: stamp, status: "expired", ...values,
    id, tenantId: github.tenantId, principalId: null, providerId: github.providerId, oauthClientId: null, name: GITHUB_READ_CREDENTIAL,
    type: "api_key", description: null, refreshSecret: null, scopes: null, createdAt: stamp, updatedAt: stamp,
  });
}

export type GithubTokenDeps = {
  db: DB["db"];
  cipher: CredentialCipher;
  githubApiOrigin: string;
  router: Parameters<typeof pushCredentialReconcile>[1];
  loadRunCredentials: RunCredentialsLoader;
  log: (entry: Record<string, unknown>) => void;
  fetch?: typeof fetch;
};

/** Only the read token was refused: the write token renewed, so only `github-read` is marked failed. */
class ReadTokenRefused extends Error {}

export function createGithubTokenRenewal(deps: GithubTokenDeps) {
  const transport = { apiOrigin: deps.githubApiOrigin, ...(deps.fetch && { fetch: deps.fetch }) };
  const appFetch = createGithubAppCredentialFetch(transport);
  const { credential, workflowRun } = schema;

  async function issue(tenantId: string, appJson: string): Promise<IssuedApp> {
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
    const app = await json(gh, "/app") as { slug?: unknown };
    if (typeof app.slug !== "string" || app.slug === "") throw new Error("github returned an invalid App slug");
    const active = (await listInstallations(gh)).filter((installation) => !installation.suspended);
    const records = await githubRecords(deps.db, tenantId);
    const primary = primaryInstallation(active, installationsOf(records));
    if (!primary) return { slug: app.slug };
    const token = await mintInstallationToken(transport, appJson, primary.id);
    const scope = readScope(records, primary.id);
    return { slug: app.slug, token, ...(scope && { read: await readToken(appJson, primary.id, scope) }) };
  }

  async function readToken(appJson: string, installationId: number, scope: TokenScope): Promise<NonNullable<IssuedApp["read"]>> {
    try {
      return await mintInstallationToken(transport, appJson, installationId, scope);
    } catch (err) {
      return { error: errorText(err) };
    }
  }

  /** Not only the workspace's own runs: a child workspace's runs hold the parent's credential they inherit. */
  async function holders(credentialId: string): Promise<string[]> {
    const runs = await deps.db.query.workflowRun.findMany({
      where: and(
        inArray(workflowRun.status, [...schema.liveWorkflowRunStatuses]),
        isNotNull(workflowRun.address),
        sql`${workflowRun.credentialRefs} -> 'credentialIds' @> ${JSON.stringify([credentialId])}::jsonb`,
      ),
      columns: { address: true },
    });
    return runs.flatMap((run) => (run.address === null ? [] : [run.address]));
  }

  /**
   * Sends the current material of the `github` credential `tenantId` resolves to, its own or a parent's, to each running
   * deployment holding it, expired too: a blank sent after a key moved replaces the key a sidecar was given.
   */
  async function push(tenantId: string): Promise<void> {
    for (const name of [GITHUB_CREDENTIAL, GITHUB_READ_CREDENTIAL]) {
      const held = await heldCredential(deps.db, tenantId, name);
      if (!held) continue;
      for (const address of await holders(held.id)) await pushCredentialReconcile(deps.db, deps.router, address, deps.cipher, deps.loadRunCredentials);
    }
  }

  /** Stores what was issued for `appJson`, unless the App was replaced while it was minted: the replacement wrote its own. */
  async function store(tenantId: string, appJson: string, issued: IssuedApp): Promise<boolean> {
    return deps.db.transaction(async function storeToken(tx) {
      await lockGithubCredentials(tx, tenantId);
      const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      const key = await lockedCredential(tx, tenantId, GITHUB_APP_KEY_CREDENTIAL);
      if (!github || github.status === "revoked" || key?.status !== "active") return false;
      if ((await decryptSecret(deps.cipher, key)) !== appJson || isGithubAppJson(await decryptSecret(deps.cipher, github))) return false;
      const token = issued.token && { secret: await deps.cipher.encrypt(issued.token.token, credentialAad(github.id, "secret")), expiresAt: new Date(issued.token.expiresAt), status: "active" as const };
      // updatedAt stays: a GitHub setup that replaces the App refuses to commit once it moved, and a renewal replaces nothing.
      await tx.update(credential).set({ metadata: renewedMetadata(github.metadata, issued.slug), ...token }).where(eq(credential.id, github.id));
      if (issued.read) await storeReadToken(tx, deps.cipher, github, issued.read);
      return token !== undefined;
    });
  }

  /**
   * Keeps why a renewal failed for the portal. A token past its expiry marks the credential `expired`, which stock
   * does not resolve for a launch, so no worker is deployed with it; one with time left stays usable meanwhile.
   */
  async function markFailed(tenantId: string, reason: string, names: readonly string[]): Promise<void> {
    await deps.db.transaction(async function markFailure(tx) {
      await lockGithubCredentials(tx, tenantId);
      for (const name of names) {
        const held = await lockedCredential(tx, tenantId, name);
        if (!held || held.status === "revoked") continue;
        const expired = held.expiresAt === null || held.expiresAt.getTime() <= Date.now();
        await tx.update(credential).set({ metadata: { ...asRecord(held.metadata), [TOKEN_ERROR]: reason }, ...(expired && { status: "expired" as const }) }).where(eq(credential.id, held.id));
      }
    });
  }

  async function renewWith(tenantId: string, appJson: string): Promise<void> {
    const issued = await issue(tenantId, appJson);
    if (!(await store(tenantId, appJson, issued)) || !issued.token) return;
    await push(tenantId);
    deps.log({ level: "info", msg: "github_token_renewed", tenantId, expiresAt: new Date(issued.token.expiresAt).toISOString() });
    // Thrown after the write token is pushed, so the workspace is retried early rather than at the next full pass.
    if (issued.read && "error" in issued.read) throw new ReadTokenRefused(issued.read.error);
  }

  async function recorded(tenantId: string, attempt: () => Promise<void>): Promise<void> {
    try {
      await attempt();
    } catch (err) {
      await markFailed(tenantId, errorText(err), err instanceof ReadTokenRefused ? [GITHUB_READ_CREDENTIAL] : [GITHUB_CREDENTIAL, GITHUB_READ_CREDENTIAL]);
      throw err;
    }
  }

  /**
   * Moves App JSON a stock write left in the `github` credential to the hub, and takes it back from every sidecar given it.
   * Stock drops a push a sidecar did not take, so a credential left without a live token is pushed again on every pass.
   */
  async function secure(tenantId: string): Promise<void> {
    const moved = await moveAppKey(deps, tenantId);
    const github = await heldCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (moved || (github?.expiresAt?.getTime() ?? Infinity) <= Date.now()) await push(tenantId);
  }

  const keyDeps = { db: deps.db, cipher: deps.cipher, onKeyMoved: push };

  /** Renews the token of the workspace whose credential `tenantId` resolves to, its own or a parent's. */
  async function renew(tenantId: string): Promise<void> {
    const owner = (await heldCredential(deps.db, tenantId, GITHUB_CREDENTIAL))?.tenantId;
    if (owner === undefined) return;
    await recorded(owner, async function renewToken() {
      await secure(owner);
      await renewWith(owner, await githubAppKey(keyDeps, owner));
    });
  }

  /** A key and read token whose `github` credential was removed or revoked through the stock route go with it. */
  async function dropOrphanKey(tenantId: string): Promise<void> {
    await deps.db.transaction(async function drop(tx) {
      await lockGithubCredentials(tx, tenantId);
      const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      if (github && github.status !== "revoked") return;
      await tx.delete(credential).where(and(eq(credential.tenantId, tenantId), inArray(credential.name, [GITHUB_APP_KEY_CREDENTIAL, GITHUB_READ_CREDENTIAL])));
      deps.log({ level: "info", msg: "github_app_key_dropped", tenantId });
    });
  }

  /** Workspaces whose last renewal failed; until the next full pass is due, an early pass retries only these. */
  const failed = new Set<string>();
  let fullPassAt = 0;

  /** Every workspace with GitHub connected, or only the failed ones on an early retry; a rate limit names when it lifts. */
  async function renewAll(): Promise<ReconcileOutcome> {
    const full = failed.size === 0 || Date.now() >= fullPassAt;
    if (full) fullPassAt = Date.now() + GITHUB_TOKEN_RENEW_MS - RETRY_SLACK_MS;
    const rows = await deps.db.select({ tenantId: credential.tenantId, name: credential.name, status: credential.status }).from(credential)
      .where(inArray(credential.name, [GITHUB_CREDENTIAL, GITHUB_APP_KEY_CREDENTIAL]));
    const connected = new Set(rows.flatMap((row) => (row.name === GITHUB_CREDENTIAL && row.status !== "revoked" ? [row.tenantId] : [])));
    let retryAt: number | undefined;
    for (const { tenantId, name, status } of rows) {
      if (name === GITHUB_APP_KEY_CREDENTIAL) {
        if (full && !connected.has(tenantId)) await dropOrphanKey(tenantId);
        continue;
      }
      if (status === "revoked" || (!full && !failed.has(tenantId))) continue;
      try {
        await renew(tenantId);
        failed.delete(tenantId);
      } catch (err) {
        failed.add(tenantId);
        if (err instanceof GithubRateLimited) retryAt = Math.min(retryAt ?? err.resetAt, err.resetAt);
        deps.log({ level: "error", msg: "github_token_renew_failed", tenantId, error: errorText(err) });
      }
    }
    return { retry: failed.size > 0, ...(retryAt !== undefined && { retryAt }) };
  }

  return { issue, push, secure, renew, renewAll };
}

export type GithubTokenRenewal = ReturnType<typeof createGithubTokenRenewal>;
