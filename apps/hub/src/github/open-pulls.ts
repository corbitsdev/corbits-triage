// Open pull requests for the workspace's connected repositories, read through
// the tenant's vaulted GitHub App credential so the portal never calls GitHub.
import { eq } from "drizzle-orm";
import { schema } from "@intx/db";
import { authorAssociation, authorKindOf, type AuthorKind } from "@corbits/triage-contracts";
import { listOpenPrs, type GithubFetch } from "@corbits/github-tool/github";
import { createGithubAppCredentialFetch, INSTALLATION_SELECTOR_HEADER } from "./github-app-credential-adapter.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { repoRecords, triageNs, type RepoRecord } from "./tenant-config.js";

export const GITHUB_OPEN_PULLS_PATH = "/api/integrations/github-open-pulls";

type GithubOpenPr = Awaited<ReturnType<typeof listOpenPrs>>[number];
type OpenPr = Omit<GithubOpenPr, "authorAssociation" | "authorBot"> & { authorKind?: AuthorKind };
type RepoPulls = { repo: string; prs: OpenPr[]; error?: string };

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

export function createGithubOpenPulls(deps: PortalCredentialDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function pullsFor(gh: GithubFetch, record: RepoRecord): Promise<RepoPulls> {
    try {
      const prs = await listOpenPrs(forInstallation(gh, record.installationId), record.name);
      return { repo: record.name, prs: prs.map(withAuthorKind) };
    } catch (err) {
      return { repo: record.name, prs: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  return async function openPulls(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    const appJson = await githubAppCredential(deps, principalId, tenantId, "use");
    if (appJson instanceof Response) return appJson;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    const tenant = await deps.db.query.tenant.findFirst({ where: eq(schema.tenant.id, tenantId) });
    if (!tenant) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    const connected = repoRecords(triageNs(tenant.config)).filter((record) => record.connected);
    return Response.json({ repos: await Promise.all(connected.map((record) => pullsFor(gh, record))) });
  };
}
