// Pull request heads for a tenant's repositories, read as the tenant's GitHub
// App, for hub-side work.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { getChecks, getPr, listOpenPrs, type GithubFetch } from "@corbits/github-tool/github";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch } from "./portal-credential.js";
import type { OpenPr } from "./reconcile-plan.js";
import type { RepoRecord } from "./tenant-config.js";

export type OpenHeadsReader = (record: RepoRecord) => Promise<OpenPr[]>;
/** One pull request's head sha, or undefined when it is not open. */
export type PullHeadReader = (appJson: string, record: RepoRecord, number: number) => Promise<string | undefined>;

export function createPullHeadReader(deps: { githubApiOrigin: string }): PullHeadReader {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });
  return async function pullHead(appJson, record, number) {
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
    const pr = await getPr(forInstallation(gh, record.installationId), record.name, number);
    return pr.state === "open" && typeof pr.sha === "string" && pr.sha !== "" ? pr.sha : undefined;
  };
}

type TenantGithubDeps = { db: DB["db"]; cipher: CredentialCipher; githubApiOrigin: string };

/** GitHub as the tenant's App; undefined when the tenant has no active GitHub App credential. */
function createTenantGithub(deps: TenantGithubDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });
  return async function tenantGithub(tenantId: string): Promise<GithubFetch | undefined> {
    const credential = await deps.db.query.credential.findFirst({
      where: and(eq(schema.credential.tenantId, tenantId), eq(schema.credential.name, "github"), eq(schema.credential.status, "active")),
    });
    if (!credential) return undefined;
    const appJson = await deps.cipher.decrypt(credential.secret, credentialAad(credential.id, "secret"));
    return appGithubFetch(appFetch, deps.githubApiOrigin, appJson);
  };
}

export function createTenantOpenHeads(deps: TenantGithubDeps) {
  const tenantGithub = createTenantGithub(deps);

  /** Undefined when the tenant has no active GitHub App credential. */
  return async function openHeadsFor(tenantId: string): Promise<OpenHeadsReader | undefined> {
    const gh = await tenantGithub(tenantId);
    if (!gh) return undefined;
    return async function openHeads(record) {
      const prs = await listOpenPrs(forInstallation(gh, record.installationId), record.name);
      return prs.flatMap((pr) => (typeof pr.sha === "string" && pr.sha !== "" ? [{ number: pr.number, headSha: pr.sha, updatedAt: pr.updatedAt, draft: pr.draft }] : []));
    };
  };
}

export type HeadChecksReader = (tenantId: string, record: RepoRecord, headSha: string) => Promise<Awaited<ReturnType<typeof getChecks>>>;

export function createTenantHeadChecks(deps: TenantGithubDeps): HeadChecksReader {
  const tenantGithub = createTenantGithub(deps);
  return async function headChecks(tenantId, record, headSha) {
    const gh = await tenantGithub(tenantId);
    if (!gh) throw new Error("no active github credential");
    return getChecks(forInstallation(gh, record.installationId), record.name, headSha);
  };
}
