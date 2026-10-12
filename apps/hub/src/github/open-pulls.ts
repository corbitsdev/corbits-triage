// Open pull requests for the workspace's connected repositories, read through
// the tenant's vaulted GitHub App credential so the portal never calls GitHub.
import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import { authorAssociation, authorKindOf, type AuthorKind } from "@corbits/triage-contracts";
import { listOpenPrs, type GithubFetch } from "@corbits/github-reads";
import { createGithubAppCredentialFetch, INSTALLATION_SELECTOR_HEADER } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";

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

async function pullsFor(gh: GithubFetch, record: RepoRecord): Promise<RepoPulls> {
  try {
    const prs = await listOpenPrs(forInstallation(gh, record.installationId), record.name);
    return { repo: record.name, prs: prs.map(withAuthorKind) };
  } catch (err) {
    return { repo: record.name, prs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Each repository's open pull requests, or why GitHub could not list them. */
export function listRepoPulls(gh: GithubFetch, records: readonly RepoRecord[]): Promise<RepoPulls[]> {
  return Promise.all(records.map((record) => pullsFor(gh, record)));
}

export type OpenPullsRead = { at: number; repos: RepoPulls[] };

/** GitHub's last listing of each tenant's open pull requests, shared by the portal's listing and the verdict route. */
export type OpenPullsCache = {
  /** The last listing, when it is younger than `maxAgeMs`. */
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

export function createGithubOpenPulls(deps: PortalCredentialDeps & { githubApiOrigin: string; cache: OpenPullsCache }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function openPulls(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) return appJson;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);
    const listed = deps.cache.kept(tenantId, RELIST_MS) ?? await deps.cache.read(tenantId, () => listRepoPulls(gh, connected));
    return Response.json({ repos: listed.repos });
  };
}
