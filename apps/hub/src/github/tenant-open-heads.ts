// Pull request heads for a tenant's repositories, read as the tenant's GitHub
// App or Bitbucket Data Center token by each record's source, for hub-side work.
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { credentialAad, type CredentialCipher } from "@intx/types";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { getChecks, listOpenPrs, readPr, type GithubFetch } from "@corbits/github-reads";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch } from "./portal-credential.js";
import type { OpenPr } from "./reconcile-plan.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";

export type OpenHeadsReader = (record: RepoRecord) => Promise<OpenPr[]>;
export type OpenHeadReader = (record: RepoRecord, number: number) => Promise<Pick<OpenPr, "headSha" | "draft"> | undefined>;

export type TenantGithubDeps = { db: DB["db"]; cipher: CredentialCipher; githubApiOrigin: string };

export type TenantSourcesDeps = TenantGithubDeps & { tenantBitbucket: TenantBitbucket };

/** The credential the record's host needs, when the tenant holds it. */
type SourceFetches = { github: GithubFetch | undefined; bitbucket: bitbucket.BitbucketFetch | undefined };

function missingCredential(record: RepoRecord): Error {
  return new Error(`no active ${sourceOf(record)} credential for ${record.name}`);
}

function githubOf(fetches: SourceFetches, record: RepoRecord): GithubFetch {
  if (!fetches.github) throw missingCredential(record);
  return forInstallation(fetches.github, record.installationId);
}

function bitbucketOf(fetches: SourceFetches, record: RepoRecord): bitbucket.BitbucketFetch {
  if (!fetches.bitbucket) throw missingCredential(record);
  return fetches.bitbucket;
}

function openHeadsOf(prs: Array<{ number: number; sha?: string; updatedAt: string; draft: boolean }>): OpenPr[] {
  return prs.flatMap((pr) => (typeof pr.sha === "string" && pr.sha !== "" ? [{ number: pr.number, headSha: pr.sha, updatedAt: pr.updatedAt, draft: pr.draft }] : []));
}

function openHeadOf(pr: { state: string; sha?: string; draft?: boolean }) {
  return pr.state === "open" && typeof pr.sha === "string" && pr.sha !== "" ? { headSha: pr.sha, draft: pr.draft === true } : undefined;
}

function createTenantSources(deps: TenantSourcesDeps) {
  const tenantGithub = createTenantGithub(deps);
  return async function tenantSources(tenantId: string): Promise<SourceFetches> {
    return { github: await tenantGithub(tenantId), bitbucket: await deps.tenantBitbucket(tenantId) };
  };
}

export function createTenantGithub(deps: TenantGithubDeps) {
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

/** Undefined when the tenant holds no credential for any host; a record whose host's credential is missing fails on read. */
export function createTenantOpenHeads(deps: TenantSourcesDeps) {
  const tenantSources = createTenantSources(deps);

  return async function openHeadsFor(tenantId: string): Promise<OpenHeadsReader | undefined> {
    const fetches = await tenantSources(tenantId);
    if (!fetches.github && !fetches.bitbucket) return undefined;
    return async function openHeads(record) {
      if (sourceOf(record) === "bitbucket-datacenter") return openHeadsOf(await bitbucket.listOpenPrs(bitbucketOf(fetches, record), record.name));
      return openHeadsOf(await listOpenPrs(githubOf(fetches, record), record.name));
    };
  };
}

export function createTenantOpenHead(deps: TenantSourcesDeps) {
  const tenantSources = createTenantSources(deps);

  return async function openHeadFor(tenantId: string): Promise<OpenHeadReader | undefined> {
    const fetches = await tenantSources(tenantId);
    if (!fetches.github && !fetches.bitbucket) return undefined;
    return async function openHead(record, number) {
      if (sourceOf(record) === "bitbucket-datacenter") return openHeadOf(await bitbucket.getPr(bitbucketOf(fetches, record), record.name, number));
      return openHeadOf(await readPr(githubOf(fetches, record), record.name, number));
    };
  };
}

export type HeadChecksReader = (tenantId: string, record: RepoRecord, headSha: string) => Promise<Awaited<ReturnType<typeof getChecks>>>;

export function createTenantHeadChecks(deps: TenantSourcesDeps): HeadChecksReader {
  const tenantSources = createTenantSources(deps);
  return async function headChecks(tenantId, record, headSha) {
    const fetches = await tenantSources(tenantId);
    if (sourceOf(record) === "bitbucket-datacenter") return bitbucket.getChecks(bitbucketOf(fetches, record), headSha);
    return getChecks(githubOf(fetches, record), record.name, headSha);
  };
}
