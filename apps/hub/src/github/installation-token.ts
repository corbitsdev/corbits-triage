// Keeps each workspace's `github` credential holding a live installation token,
// minted on the hub from the App key, and pushes each new one to the running
// deployments that hold the credential: a stock secret update alone reaches them
// only when their sidecar reconnects.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { pushCredentialReconcile } from "@intx/hub-sessions";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { errorText } from "@corbits/common";
import { listInstallations } from "@corbits/github-reads";
import { GITHUB_CREDENTIAL, githubAppKey } from "./app-key.js";
import { createGithubAppCredentialFetch, mintInstallationToken } from "./github-app-credential-adapter.js";
import { activeCredential, appGithubFetch } from "./portal-credential.js";

/** Installation tokens last an hour. */
export const GITHUB_TOKEN_RENEW_MS = 45 * 60_000;
/** A worker is deployed with the token it reads, so one with less left than this is renewed first. */
const MIN_TOKEN_LIFE_MS = 15 * 60_000;

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

  /** One token covers one installation; nothing is minted before the App is installed. */
  async function mint(appJson: string) {
    const installations = (await listInstallations(appGithubFetch(appFetch, deps.githubApiOrigin, appJson))).filter((installation) => !installation.suspended);
    if (installations.length === 0) return undefined;
    if (installations.length > 1) throw new Error(`the GitHub App has ${installations.length} active installations; a workspace's token covers one`);
    return mintInstallationToken(transport, appJson, installations[0]!.id);
  }

  async function holders(tenantId: string, credentialId: string): Promise<string[]> {
    const runs = await deps.db.query.workflowRun.findMany({
      where: and(eq(workflowRun.tenantId, tenantId), inArray(workflowRun.status, [...schema.liveWorkflowRunStatuses]), isNotNull(workflowRun.address), isNotNull(workflowRun.credentialRefs)),
      columns: { address: true, credentialRefs: true },
    });
    return runs.flatMap((run) => (run.address !== null && run.credentialRefs?.credentialIds.includes(credentialId) ? [run.address] : []));
  }

  async function renewWith(tenantId: string, appJson: string): Promise<void> {
    const minted = await mint(appJson);
    const github = await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (!minted || !github) return;
    const secret = await deps.cipher.encrypt(minted.token, credentialAad(github.id, "secret"));
    // updatedAt stays: a GitHub setup that replaces the App refuses to commit once it moved, and a renewal replaces nothing.
    await deps.db.update(credential).set({ secret, expiresAt: new Date(minted.expiresAt) }).where(eq(credential.id, github.id));
    for (const address of await holders(tenantId, github.id)) await pushCredentialReconcile(deps.db, deps.router, address, deps.cipher);
    deps.log({ level: "info", msg: "github_token_renewed", tenantId, expiresAt: new Date(minted.expiresAt).toISOString() });
  }

  async function renew(tenantId: string): Promise<void> {
    await renewWith(tenantId, await githubAppKey(deps, tenantId));
  }

  /** Renews the token unless it has long enough left; reading the key first moves one a connection just wrote, which leaves no token. */
  async function ensure(tenantId: string): Promise<void> {
    if (!(await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL))) return;
    const appJson = await githubAppKey(deps, tenantId);
    const github = await activeCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (github?.expiresAt && github.expiresAt.getTime() - Date.now() > MIN_TOKEN_LIFE_MS) return;
    await renewWith(tenantId, appJson);
  }

  /** Every workspace with GitHub connected; a workspace that failed asks for an early retry. */
  async function renewAll(): Promise<{ retry: boolean }> {
    const rows = await deps.db.select({ tenantId: credential.tenantId }).from(credential).where(and(eq(credential.name, GITHUB_CREDENTIAL), eq(credential.status, "active")));
    let retry = false;
    for (const { tenantId } of rows) {
      try {
        await renew(tenantId);
      } catch (err) {
        retry = true;
        deps.log({ level: "error", msg: "github_token_renew_failed", tenantId, error: errorText(err) });
      }
    }
    return { retry };
  }

  return { renew, ensure, renewAll };
}
