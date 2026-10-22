// Reads the App's installations and repositories straight from GitHub, so
// onboarding does not depend on the installation webhook arriving.
import { errorText } from "@corbits/common";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { applyInstallationListing, type InstallationListing } from "./bridge.js";
import { githubLimited } from "./github-refusal.js";
import { primaryInstallation, recordedInstallations } from "./installation-token.js";
import { appGithubFetch, failure, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import type { Member } from "../integrations/app.js";
import { patchCorbitsTriage } from "./tenant-config.js";
import { listInstallationRepositories, listInstallations, type GithubFetch, type GithubInstallation } from "@corbits/github-reads";

export const GITHUB_INSTALLATIONS_PATH = "/api/integrations/github-installations";

async function listingFor(gh: GithubFetch, installation: GithubInstallation): Promise<InstallationListing> {
  const fields = {
    installationId: installation.id,
    ...(installation.account !== undefined && { account: installation.account }),
    installationUrl: installation.htmlUrl,
    selection: installation.selection,
  };
  // GitHub refuses tokens for a suspended installation, so it cannot be listed.
  if (installation.suspended) return { fields, suspended: true };
  return { fields, suspended: false, names: await listInstallationRepositories(gh, installation.id) };
}

function accountOf(installation: GithubInstallation): string {
  return installation.account ?? `installation ${installation.id}`;
}

export function createInstallationSync(deps: PortalCredentialDeps & { githubApiOrigin: string; onSynced: (tenantId: string) => void }) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function syncInstallations({ tenantId, principalId }: Member): Promise<Response> {
    // Rewrites the workspace's repositories, so it needs what connecting GitHub needs.
    const app = await githubAppCredential(deps, principalId, tenantId, "manage");
    if (app instanceof Response) return app;
    const gh = appGithubFetch(appFetch, deps.githubApiOrigin, app.appJson);

    let installations: GithubInstallation[];
    let listings: InstallationListing[];
    try {
      installations = await listInstallations(gh);
      // One installation token serves the workspace, so only one account's repositories are kept.
      const primary = primaryInstallation(installations.filter((installation) => !installation.suspended), await recordedInstallations(deps.db, tenantId));
      const kept = installations.filter((installation) => installation.suspended || installation.id === primary?.id);
      listings = await Promise.all(kept.map((installation) => listingFor(gh, installation)));
    } catch (err) {
      return githubLimited(err) ?? failure(502, "github_failed", `Could not read the App's installations from GitHub: ${errorText(err)}.`);
    }

    const next = await patchCorbitsTriage(deps.db, tenantId, function reconcile(ns) {
      return applyInstallationListing(ns, listings);
    });
    if (next === undefined) return failure(409, "workspace_unconfigured", "The workspace is not set up yet.");
    deps.onSynced(tenantId);

    const kept = new Set(listings.map((listing) => listing.fields.installationId));
    const others = installations.filter((installation) => !installation.suspended && !kept.has(installation.id));
    if (others.length > 0) {
      const used = installations.find((installation) => kept.has(installation.id) && !installation.suspended)!;
      return failure(409, "github_second_installation", `Triage connects one GitHub account per workspace and uses ${accountOf(used)}. Remove the App from ${others.map(accountOf).join(", ")} on GitHub.`);
    }
    const repos = listings.flatMap((listing) => (listing.suspended ? [] : listing.names));
    return Response.json({ installations: listings.length, repos });
  };
}
