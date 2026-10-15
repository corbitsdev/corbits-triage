import type { BitbucketFetch } from "@corbits/bitbucket-datacenter-reads";
import type { GithubFetch } from "@corbits/github-reads";
import type { TenantBitbucket } from "../bitbucket-datacenter/tenant-bitbucket.js";
import { createGithubAppCredentialFetch } from "./github-app-credential-adapter.js";
import { forInstallation } from "./open-pulls.js";
import { appGithubFetch, githubAppCredential, type PortalCredentialDeps } from "./portal-credential.js";
import { sourceOf, type RepoRecord } from "./tenant-config.js";

/** Undefined when the tenant holds no readable credential for the repository's host. */
type SourceFetch = { bb: BitbucketFetch } | { gh: GithubFetch } | undefined;

export type SourceFetchDeps = PortalCredentialDeps & { githubApiOrigin: string; tenantBitbucket: TenantBitbucket };

/** Reads a repository's host as the tenant's GitHub App or Bitbucket Data Center token. */
export function createSourceFetch(deps: SourceFetchDeps) {
  const appFetch = createGithubAppCredentialFetch({ apiOrigin: deps.githubApiOrigin });

  return async function sourceFetch(tenantId: string, principalId: string, record: RepoRecord): Promise<SourceFetch> {
    if (sourceOf(record) === "bitbucket-datacenter") {
      const bb = await deps.tenantBitbucket(tenantId);
      return bb ? { bb } : undefined;
    }
    const appJson = await githubAppCredential(deps, principalId, tenantId, "read");
    if (appJson instanceof Response) return undefined;
    return { gh: forInstallation(appGithubFetch(appFetch, deps.githubApiOrigin, appJson), record.installationId) };
  };
}
