// Open pull requests for the workspace's connected repositories, read through
// the tenant's vaulted GitHub App credential so the portal never calls GitHub.
import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import { authorAssociation, authorKindOf, type AuthorKind, type RepoSource } from "@corbits/triage-contracts";
import { INSTALLATION_SELECTOR_HEADER, listOpenPrs, type GithubFetch } from "@corbits/github-reads";
import { errorText } from "@corbits/common";
import { failure, sourceCredentialGrant, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { repoRecords, sourceOf, triageNs, type RepoRecord } from "./tenant-config.js";

export const GITHUB_OPEN_PULLS_PATH = "/api/integrations/github-open-pulls";

type GithubOpenPr = Awaited<ReturnType<typeof listOpenPrs>>[number];
type OpenPr = Omit<GithubOpenPr, "authorAssociation" | "authorBot"> & { authorKind?: AuthorKind };
export type RepoPulls = { repo: string; prs: OpenPr[]; error?: string };

function withAuthorKind({ authorAssociation: association, authorBot, ...pr }: GithubOpenPr): OpenPr {
  const authorKind = authorKindOf(authorAssociation(association), authorBot);
  return authorKind === undefined ? pr : { ...pr, authorKind };
}

export function forInstallation(gh: GithubFetch, installationId: number | undefined): GithubFetch {
  if (installationId === undefined) return gh;
  return function installationFetch(path, init) {
    const headers = new Headers(init?.headers);
    headers.set(INSTALLATION_SELECTOR_HEADER, String(installationId));
    return gh(path, { ...init, headers });
  };
}

/** Lists one repository's open pull requests on its host; GitHub's through the tenant's App, another host's through its reader. */
export type OpenPrsLister = (tenantId: string, record: RepoRecord) => Promise<GithubOpenPr[]>;

async function pullsFor(list: OpenPrsLister, tenantId: string, record: RepoRecord): Promise<RepoPulls> {
  try {
    const prs = await list(tenantId, record);
    return { repo: record.name, prs: prs.map(withAuthorKind) };
  } catch (err) {
    return { repo: record.name, prs: [], error: errorText(err) };
  }
}

export function listRepoPulls(list: OpenPrsLister, tenantId: string, records: readonly RepoRecord[]): Promise<RepoPulls[]> {
  return Promise.all(records.map((record) => pullsFor(list, tenantId, record)));
}

/** Refuses when the member may not read a host's credential among the records' hosts; a host with no record needs nothing. */
export async function listingRefusal(deps: PortalCredentialDeps, member: Member, records: readonly RepoRecord[]): Promise<Response | undefined> {
  const sources = new Set<RepoSource>(records.map(sourceOf));
  for (const source of sources) {
    const refused = await sourceCredentialGrant(deps, member.principalId, member.tenantId, { source }, "read");
    if (refused) return refused;
  }
  return undefined;
}

export type OpenPullsRead = { at: number; repos: RepoPulls[] };

/** GitHub's last listing of each tenant's open pull requests, shared by the portal's listing and the verdict route. */
export type OpenPullsCache = {
  kept(tenantId: string, maxAgeMs: number): OpenPullsRead | undefined;
  /** Lists now and keeps the listing; callers while it is read share it. */
  read(tenantId: string, list: () => Promise<RepoPulls[]>): Promise<OpenPullsRead>;
};

export function createOpenPullsCache(now: () => Date): OpenPullsCache {
  const kept = new Map<string, OpenPullsRead>();
  const reading = new Map<string, Promise<OpenPullsRead>>();

  async function readOnce(tenantId: string, list: () => Promise<RepoPulls[]>): Promise<OpenPullsRead> {
    try {
      const listed = { at: now().getTime(), repos: await list() };
      kept.set(tenantId, listed);
      return listed;
    } finally {
      reading.delete(tenantId);
    }
  }

  return {
    kept(tenantId, maxAgeMs) {
      const listed = kept.get(tenantId);
      return listed && now().getTime() - listed.at < maxAgeMs ? listed : undefined;
    },
    read(tenantId, list) {
      const pending = reading.get(tenantId) ?? readOnce(tenantId, list);
      reading.set(tenantId, pending);
      return pending;
    },
  };
}

/** A listing this young is answered again rather than asking GitHub, so the portal and the verdict route share one read. */
const RELIST_MS = 10_000;

export function createGithubOpenPulls(deps: PortalCredentialDeps & { list: OpenPrsLister; cache: OpenPullsCache }) {
  return async function openPulls(member: Member): Promise<Response> {
    const { tenantId } = member;
    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);
    const refused = await listingRefusal(deps, member, connected);
    if (refused) return refused;
    const listed = deps.cache.kept(tenantId, RELIST_MS) ?? await deps.cache.read(tenantId, () => listRepoPulls(deps.list, tenantId, connected));
    return Response.json({ repos: listed.repos });
  };
}
