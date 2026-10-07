// Reads the App's installations and repositories straight from GitHub, so
// onboarding does not depend on the installation webhook arriving.
import { type } from "arktype";
import { createGithubAppCredentialFetch, INSTALLATION_SELECTOR_HEADER } from "./github-app-credential-adapter.js";
import { applyInstallationListing, sendBacklog, type BacklogDeps, type InstallationListing } from "./bridge.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { markBacklogFailed, patchCorbitsTriage, type CorbitsTriageNs } from "./tenant-config.js";
import type { GithubFetch } from "@corbits/github-tool/github";

export const GITHUB_INSTALLATIONS_PATH = "/api/integrations/github-installations";

const PAGE_SIZE = 100;

// Enterprise accounts carry a slug instead of a login.
const Installation = type({
  id: "number.integer > 0",
  account: type({ "login?": "string", "slug?": "string" }).or("null"),
  html_url: "string",
  repository_selection: "'all' | 'selected'",
  suspended_at: "string | null",
});
type Installation = typeof Installation.infer;

const RepositoryPage = type({ repositories: type({ full_name: "string" }).array() });

function logJson(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

async function getJson(gh: GithubFetch, path: string, headers: Record<string, string>): Promise<unknown> {
  const response = await gh(path, { headers });
  if (!response.ok) throw new Error(`GET ${path} -> ${String(response.status)}`);
  return response.json();
}

async function listInstallations(gh: GithubFetch): Promise<Installation[]> {
  const all: Installation[] = [];
  for (let page = 1; ; page += 1) {
    const rows = Installation.array().assert(await getJson(gh, `/app/installations?per_page=${PAGE_SIZE}&page=${page}`, {}));
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
}

async function listRepositories(gh: GithubFetch, installationId: number): Promise<string[]> {
  const names: string[] = [];
  const selector = { [INSTALLATION_SELECTOR_HEADER]: String(installationId) };
  for (let page = 1; ; page += 1) {
    const { repositories } = RepositoryPage.assert(
      await getJson(gh, `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`, selector),
    );
    names.push(...repositories.map((repo) => repo.full_name));
    if (repositories.length < PAGE_SIZE) return names;
  }
}

async function listingFor(gh: GithubFetch, installation: Installation): Promise<InstallationListing> {
  const account = installation.account?.login ?? installation.account?.slug;
  const fields = {
    installationId: installation.id,
    ...(account !== undefined && { account }),
    installationUrl: installation.html_url,
    selection: installation.repository_selection,
  };
  // GitHub refuses tokens for a suspended installation, so it cannot be listed.
  if (installation.suspended_at !== null) return { fields, suspended: true };
  return { fields, suspended: false, names: await listRepositories(gh, installation.id) };
}

export function createInstallationSync(deps: PortalCredentialDeps & BacklogDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  async function mailNewRepositories(tenantId: string, ns: CorbitsTriageNs, added: readonly string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const repo of added) {
      try {
        await sendBacklog(deps, tenantId, ns, [repo]);
      } catch (err) {
        logJson({ level: "warn", msg: "backlog_mail_failed", tenantId, repo, error: String(err) });
        failed.push(repo);
      }
    }
    return failed;
  }

  return async function syncInstallations(req: Request, tenantId: string): Promise<Response> {
    const principalId = await portalMember(deps, req, tenantId);
    if (principalId instanceof Response) return principalId;
    // Rewrites the workspace's repositories, so it needs what connecting GitHub needs.
    const appJson = await githubAppCredential(deps, principalId, tenantId, "manage");
    if (appJson instanceof Response) return appJson;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, appJson);

    let listings: InstallationListing[];
    try {
      listings = await Promise.all((await listInstallations(gh)).map((installation) => listingFor(gh, installation)));
    } catch (err) {
      return failure(502, "github_failed", `Could not read the App's installations from GitHub: ${err instanceof Error ? err.message : String(err)}.`);
    }

    let added: string[] = [];
    const next = await patchCorbitsTriage(deps.db, tenantId, function reconcile(ns) {
      const result = applyInstallationListing(ns, listings);
      added = result.added;
      return result.ns;
    });
    if (next === undefined) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");

    const failed = await mailNewRepositories(tenantId, next, added);
    if (failed.length > 0) await patchCorbitsTriage(deps.db, tenantId, (ns) => markBacklogFailed(ns, failed));
    const repos = listings.flatMap((listing) => (listing.suspended ? [] : listing.names));
    return Response.json({ installations: listings.length, repos, backlogFailed: failed });
  };
}
