// Reads the App's installations and repositories straight from GitHub, so
// onboarding does not depend on the installation webhook arriving.
import { type } from "arktype";
import { createGithubAppCredentialFetch, INSTALLATION_SELECTOR_HEADER } from "./github-app-credential-adapter.js";
import { applyInstallationListing, sendBacklog, type BacklogDeps, type InstallationListing } from "./bridge.js";
import { appGithubFetch, failure, githubCredentialForPortal, type PortalCredentialDeps } from "./portal-credential.js";
import { patchCorbitsTriage } from "./tenant-config.js";
import type { GithubFetch } from "@corbits/github-tool/github";

export const GITHUB_INSTALLATIONS_PATH = "/api/integrations/github-installations";

const PAGE_SIZE = 100;

const InstallationPage = type({
  id: "number.integer > 0",
  account: type({ login: "string" }).or("null"),
  html_url: "string",
  repository_selection: "'all' | 'selected'",
}).array();

const RepositoryPage = type({ repositories: type({ full_name: "string" }).array() });

async function getJson(gh: GithubFetch, path: string, headers: Record<string, string>): Promise<unknown> {
  const response = await gh(path, { headers });
  if (!response.ok) throw new Error(`GET ${path} -> ${String(response.status)}`);
  return response.json();
}

async function listInstallations(gh: GithubFetch): Promise<(typeof InstallationPage.infer)> {
  const all: typeof InstallationPage.infer = [];
  for (let page = 1; ; page += 1) {
    const rows = InstallationPage.assert(await getJson(gh, `/app/installations?per_page=${PAGE_SIZE}&page=${page}`, {}));
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

async function listingFor(gh: GithubFetch, installation: typeof InstallationPage.infer[number]): Promise<InstallationListing> {
  return {
    fields: {
      installationId: installation.id,
      ...(installation.account !== null && { account: installation.account.login }),
      installationUrl: installation.html_url,
      selection: installation.repository_selection,
    },
    names: await listRepositories(gh, installation.id),
  };
}

export function createInstallationSync(deps: PortalCredentialDeps & BacklogDeps & { githubApiOrigin: string }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function syncInstallations(req: Request, tenantId: string): Promise<Response> {
    const access = await githubCredentialForPortal(deps, req, tenantId);
    if (access instanceof Response) return access;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, access.appJson);

    let listings: InstallationListing[];
    try {
      listings = await Promise.all((await listInstallations(gh)).map((installation) => listingFor(gh, installation)));
    } catch (err) {
      return failure(502, "github_failed", `Could not read the App's installations from GitHub: ${err instanceof Error ? err.message : String(err)}.`);
    }

    const next = await patchCorbitsTriage(deps.db, tenantId, (ns) => applyInstallationListing(ns, listings));
    if (next === undefined) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");

    const listed = listings.flatMap((listing) => listing.names);
    try {
      await sendBacklog(deps, tenantId, next, listed);
    } catch (err) {
      // Repositories are saved; catch-up is retried on the next sync or install event.
      console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "backlog_mail_failed", tenantId, error: String(err) }));
    }
    return Response.json({ installations: listings.length, repos: listed });
  };
}
