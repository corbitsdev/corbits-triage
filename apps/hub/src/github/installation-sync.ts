// Reads the App's installations and repositories straight from GitHub, so
// onboarding does not depend on the installation webhook arriving.
import { type } from "arktype";
import { createGithubAppCredentialFetch, INSTALLATION_SELECTOR_HEADER } from "./github-app-credential-adapter.js";
import { applyInstallationListing, type InstallationListing } from "./bridge.js";
import { appGithubFetch, failure, githubAppCredential, portalMember, type PortalCredentialDeps } from "./portal-credential.js";
import { patchCorbitsTriage } from "./tenant-config.js";
import { jsonAll, type GithubFetch } from "@corbits/github-tool/github";

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

async function listInstallations(gh: GithubFetch): Promise<Installation[]> {
  return Installation.array().assert(await jsonAll(gh, `/app/installations?per_page=${PAGE_SIZE}`));
}

async function listRepositories(gh: GithubFetch, installationId: number): Promise<string[]> {
  const init = { headers: { [INSTALLATION_SELECTOR_HEADER]: String(installationId) } };
  const repositories = await jsonAll(gh, `/installation/repositories?per_page=${PAGE_SIZE}`, {
    init,
    items: (page) => RepositoryPage.assert(page).repositories,
  });
  return repositories.map((repo) => repo.full_name);
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

export function createInstallationSync(deps: PortalCredentialDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

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

    const next = await patchCorbitsTriage(deps.db, tenantId, function reconcile(ns) {
      return applyInstallationListing(ns, listings);
    });
    if (next === undefined) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");

    const repos = listings.flatMap((listing) => (listing.suspended ? [] : listing.names));
    return Response.json({ installations: listings.length, repos });
  };
}
