// Keeps each workspace's `github` credential holding a live installation token,
// minted on the hub from the App key, and pushes each new one to the running
// deployments that hold the credential: a stock secret update alone reaches them
// only when their sidecar reconnects.
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { pushCredentialReconcile, type RunCredentialsLoader } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { asRecord, errorText } from "@corbits/common";
import { json, listInstallations, type GithubInstallation } from "@corbits/github-reads";
import { decryptSecret, GITHUB_APP_KEY_CREDENTIAL, GITHUB_CREDENTIAL, githubAppKey, lockedCredential, lockGithubCredentials, moveAppKey, renewedMetadata, TOKEN_ERROR } from "./app-key.js";
import { tenantConfigOf } from "./bridge.js";
import { createGithubAppCredentialFetch, isGithubAppJson, mintInstallationToken } from "./github-app-credential-adapter.js";
import { GithubRateLimited } from "./github-usage.js";
import type { ReconcileOutcome } from "./triage-reconciler.js";
import { appGithubFetch, heldCredential } from "./portal-credential.js";
import { repoRecords, sourceOf, triageNs } from "./tenant-config.js";

/** Installation tokens last an hour. */
export const GITHUB_TOKEN_RENEW_MS = 45 * 60_000;
/** A worker is deployed with the token it reads, so one with less left than this is renewed first. */
const MIN_TOKEN_LIFE_MS = 15 * 60_000;
/** A full pass falls due a little before the renewal interval fires, so the interval's pass is always full. */
const RETRY_SLACK_MS = 60_000;

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
  loadRunCredentials: RunCredentialsLoader;
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
    const github = await heldCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (!github) return;
    for (const address of await holders(github.id)) await pushCredentialReconcile(deps.db, deps.router, address, deps.cipher, deps.loadRunCredentials);
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
      return token !== undefined;
    });
  }

  /**
   * Keeps why a renewal failed for the portal. A token past its expiry marks the credential `expired`, which stock
   * does not resolve for a launch, so no worker is deployed with it; one with time left stays usable meanwhile.
   */
  async function markFailed(tenantId: string, reason: string): Promise<void> {
    await deps.db.transaction(async function markFailure(tx) {
      await lockGithubCredentials(tx, tenantId);
      const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      if (!github || github.status === "revoked") return;
      const expired = github.expiresAt === null || github.expiresAt.getTime() <= Date.now();
      await tx.update(credential).set({ metadata: { ...asRecord(github.metadata), [TOKEN_ERROR]: reason }, ...(expired && { status: "expired" as const }) }).where(eq(credential.id, github.id));
    });
  }

  async function renewWith(tenantId: string, appJson: string): Promise<void> {
    const issued = await issue(tenantId, appJson);
    if (!(await store(tenantId, appJson, issued)) || !issued.token) return;
    await push(tenantId);
    deps.log({ level: "info", msg: "github_token_renewed", tenantId, expiresAt: new Date(issued.token.expiresAt).toISOString() });
  }

  async function recorded(tenantId: string, attempt: () => Promise<void>): Promise<void> {
    try {
      await attempt();
    } catch (err) {
      await markFailed(tenantId, errorText(err));
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

  /**
   * Renews the token of the workspace whose credential `tenantId` resolves to unless it is active with long enough left;
   * reading the key first moves one a stock write left, which leaves no token.
   */
  async function ensure(tenantId: string): Promise<void> {
    const owner = (await heldCredential(deps.db, tenantId, GITHUB_CREDENTIAL))?.tenantId;
    if (owner === undefined) return;
    await recorded(owner, async function ensureToken() {
      await secure(owner);
      const appJson = await githubAppKey(keyDeps, owner);
      const github = await heldCredential(deps.db, owner, GITHUB_CREDENTIAL);
      if (github?.status === "active" && github.expiresAt && github.expiresAt.getTime() - Date.now() > MIN_TOKEN_LIFE_MS) return;
      await renewWith(owner, appJson);
    });
  }

  /** A key whose `github` credential was removed or revoked through the stock route goes with it. */
  async function dropOrphanKey(tenantId: string): Promise<void> {
    await deps.db.transaction(async function drop(tx) {
      await lockGithubCredentials(tx, tenantId);
      const github = await lockedCredential(tx, tenantId, GITHUB_CREDENTIAL);
      if (github && github.status !== "revoked") return;
      await tx.delete(credential).where(and(eq(credential.tenantId, tenantId), eq(credential.name, GITHUB_APP_KEY_CREDENTIAL)));
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

  return { issue, push, secure, renew, ensure, renewAll };
}

export type GithubTokenRenewal = ReturnType<typeof createGithubTokenRenewal>;
