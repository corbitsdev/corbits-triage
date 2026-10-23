// When each repository last had a verified webhook delivery, so the reconciler lists a repository's open pull requests
// again only where they may have changed, and a policy file read is kept only while its webhook is heard.
import type { RepoSource } from "@corbits/triage-contracts";

export type RepoActivity = {
  heard(tenantId: string, source: RepoSource, repo: string): void;
  /** Whether the repository's webhook (the App's, on GitHub) heard nothing for `quietMs`, so it may be broken or unreachable. */
  quiet(tenantId: string, source: RepoSource, repo: string): boolean;
  /**
   * Whether a listing taken at `listedAt` may be stale: the repository's last delivery came less than `graceMs` before it,
   * or after it, since the host's listing can trail its webhook; the listing is `quietMs` old, in case a delivery was lost;
   * or its webhook heard nothing for `quietMs`, so it may be broken.
   */
  stale(tenantId: string, source: RepoSource, repo: string, listedAt: number): boolean;
};

/** A GitHub App's webhook is the installation's, so any GitHub delivery shows it works; Bitbucket's is each repository's own. */
function webhookKey(tenantId: string, source: RepoSource, repo: string): string {
  return source === "github" ? `${tenantId}\n${source}` : `${tenantId}\n${source}\n${repo}`;
}

export function createRepoActivity(now: () => Date, { quietMs, graceMs }: { quietMs: number; graceMs: number }): RepoActivity {
  const repos = new Map<string, number>();
  const webhooks = new Map<string, number>();
  function quiet(tenantId: string, source: RepoSource, repo: string): boolean {
    const webhookAt = webhooks.get(webhookKey(tenantId, source, repo));
    return webhookAt === undefined || now().getTime() - webhookAt >= quietMs;
  }
  return {
    quiet,
    heard(tenantId, source, repo) {
      const at = now().getTime();
      repos.set(`${tenantId}\n${source}\n${repo}`, at);
      webhooks.set(webhookKey(tenantId, source, repo), at);
    },
    stale(tenantId, source, repo, listedAt) {
      if (quiet(tenantId, source, repo) || now().getTime() - listedAt >= quietMs) return true;
      const repoAt = repos.get(`${tenantId}\n${source}\n${repo}`);
      return repoAt !== undefined && repoAt + graceMs >= listedAt;
    },
  };
}
