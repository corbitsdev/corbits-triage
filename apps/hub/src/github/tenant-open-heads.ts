// Pull request heads for a tenant's repositories, read as the tenant's GitHub
// App or Bitbucket Data Center token by each record's source, for hub-side work.
import type { DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { asRecord } from "@corbits/common";
import * as bitbucket from "@corbits/bitbucket-datacenter-reads";
import { tokenUser } from "@corbits/bitbucket-datacenter-tool/bitbucket";
import { getChecks, listOpenPrs, readPr, type GithubFetch } from "@corbits/github-reads";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { GITHUB_CREDENTIAL, githubAppKey } from "./app-key.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation, type OpenPrsLister } from "./open-pulls.js";
import { appGithubFetch, heldCredential } from "./portal-credential.js";
import type { OpenPr } from "./reconcile-plan.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";

export type OpenHeadsReader = (record: RepoRecord) => Promise<OpenPr[]>;
export type OpenHeadReader = (record: RepoRecord, number: number) => Promise<Pick<OpenPr, "headSha" | "draft"> | undefined>;

export type TenantGithubDeps = { db: DB["db"]; cipher: CredentialCipher; githubApiOrigin: string };

type TenantSourcesDeps = TenantGithubDeps & { tenantBitbucket: TenantBitbucket };

/** Each host's credential, read once per tenant lookup and only when a record of that host asks for it. */
type SourceFetches = { github: () => Promise<GithubFetch | undefined>; bitbucket: () => Promise<bitbucket.BitbucketFetch | undefined> };

function missingCredential(record: RepoRecord): Error {
  return new Error(`no active ${sourceOf(record)} credential for ${record.name}`);
}

async function githubOf(fetches: SourceFetches, record: RepoRecord): Promise<GithubFetch> {
  const gh = await fetches.github();
  if (!gh) throw missingCredential(record);
  return forInstallation(gh, record.installationId);
}

async function bitbucketOf(fetches: SourceFetches, record: RepoRecord): Promise<bitbucket.BitbucketFetch> {
  const bb = await fetches.bitbucket();
  if (!bb) throw missingCredential(record);
  return bb;
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return function memoized() {
    pending ??= read();
    return pending;
  };
}

function openHeadsOf(prs: Array<{ number: number; sha?: string; updatedAt: string; draft: boolean; labels?: string[] }>): OpenPr[] {
  return prs.flatMap((pr) => (typeof pr.sha === "string" && pr.sha !== "" ? [{ number: pr.number, headSha: pr.sha, updatedAt: pr.updatedAt, draft: pr.draft, ...(pr.labels && { labels: pr.labels }) }] : []));
}

function openHeadOf(pr: { state: string; sha?: string; draft?: boolean }) {
  return pr.state === "open" && typeof pr.sha === "string" && pr.sha !== "" ? { headSha: pr.sha, draft: pr.draft === true } : undefined;
}

function createTenantSources(deps: TenantSourcesDeps) {
  const tenantGithub = createTenantGithub(deps);
  return function tenantSources(tenantId: string): SourceFetches {
    return { github: once(() => tenantGithub(tenantId)), bitbucket: once(() => deps.tenantBitbucket(tenantId)) };
  };
}

export function createTenantGithub(deps: TenantGithubDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });
  return async function tenantGithub(tenantId: string): Promise<GithubFetch | undefined> {
    const credential = await heldCredential(deps.db, tenantId, GITHUB_CREDENTIAL);
    if (!credential) return undefined;
    return appGithubFetch(appFetch, deps.githubApiOrigin, await githubAppKey(deps, credential.tenantId));
  };
}

/** The login the workspace's GitHub App writes as, read from its credential without asking GitHub; undefined when it has no slug or can't be read, since the listing must not fail over it. */
async function appBotLogin(db: DB["db"], tenantId: string): Promise<string | undefined> {
  try {
    const slug = asRecord((await activeCredential(db, tenantId, "github"))?.metadata)?.["appSlug"];
    return typeof slug === "string" && slug !== "" ? `${slug}[bot]` : undefined;
  } catch {
    return undefined;
  }
}

/** The user Triage's Bitbucket token acts as; undefined when Bitbucket can't say, since the listing must not fail over it. */
async function bitbucketLogin(bb: bitbucket.BitbucketFetch): Promise<string | undefined> {
  try {
    return (await tokenUser(bb)).slug;
  } catch {
    return undefined;
  }
}

function markTriage<P extends { author: string | null }>(prs: P[], login: string | undefined): Array<P & { byTriage?: true }> {
  return prs.map((pr) => (login !== undefined && pr.author === login ? { ...pr, byTriage: true as const } : pr));
}

/** The portal's listing of a workspace's open pull requests, on each repository's host, marking the ones Triage opened; each host's login is read once a listing. */
export function createTenantOpenPrs(deps: TenantSourcesDeps): OpenPrsLister {
  const tenantSources = createTenantSources(deps);
  return function tenantListing(tenantId) {
    const fetches = tenantSources(tenantId);
    const githubLogin = once(() => appBotLogin(deps.db, tenantId));
    const tokenLogin = once(async function readTokenLogin() {
      const bb = await fetches.bitbucket();
      return bb && bitbucketLogin(bb);
    });
    return async function openPrs(record) {
      if (sourceOf(record) === "bitbucket-datacenter") {
        const [prs, login] = await Promise.all([bitbucket.listOpenPrs(await bitbucketOf(fetches, record), record.name), tokenLogin()]);
        return markTriage(prs, login);
      }
      const [prs, login] = await Promise.all([listOpenPrs(await githubOf(fetches, record), record.name), githubLogin()]);
      return markTriage(prs, login);
    };
  };
}

/** Undefined when the tenant holds no credential for any host; a record whose host's credential is missing fails on read. */
export function createTenantOpenHeads(deps: TenantSourcesDeps) {
  const tenantSources = createTenantSources(deps);

  return async function openHeadsFor(tenantId: string): Promise<OpenHeadsReader | undefined> {
    const fetches = tenantSources(tenantId);
    if (!(await fetches.github()) && !(await fetches.bitbucket())) return undefined;
    return async function openHeads(record) {
      if (sourceOf(record) === "bitbucket-datacenter") return openHeadsOf(await bitbucket.listOpenPrs(await bitbucketOf(fetches, record), record.name));
      return openHeadsOf(await listOpenPrs(await githubOf(fetches, record), record.name));
    };
  };
}

export function createTenantOpenHead(deps: TenantSourcesDeps) {
  const tenantSources = createTenantSources(deps);

  return async function openHeadFor(tenantId: string): Promise<OpenHeadReader | undefined> {
    const fetches = tenantSources(tenantId);
    if (!(await fetches.github()) && !(await fetches.bitbucket())) return undefined;
    return async function openHead(record, number) {
      if (sourceOf(record) === "bitbucket-datacenter") return openHeadOf(await bitbucket.getPr(await bitbucketOf(fetches, record), record.name, number));
      return openHeadOf(await readPr(await githubOf(fetches, record), record.name, number));
    };
  };
}

export type HeadChecksReader = (tenantId: string, record: RepoRecord, headSha: string) => Promise<Awaited<ReturnType<typeof getChecks>>>;

export function createTenantHeadChecks(deps: TenantSourcesDeps): HeadChecksReader {
  const tenantSources = createTenantSources(deps);
  return async function headChecks(tenantId, record, headSha) {
    const fetches = tenantSources(tenantId);
    if (sourceOf(record) === "bitbucket-datacenter") return bitbucket.getChecks(await bitbucketOf(fetches, record), headSha);
    return getChecks(await githubOf(fetches, record), record.name, headSha);
  };
}
