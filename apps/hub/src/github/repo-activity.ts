// When each repository last had a verified webhook delivery, so the reconciler
// lists a repository's open pull requests again only where they may have changed.
import type { RepoSource } from "@corbits/triage-contracts";

export type RepoActivity = {
  heard(tenantId: string, source: RepoSource, repo: string): void;
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
  return {
    heard(tenantId, source, repo) {
      const at = now().getTime();
      repos.set(`${tenantId}\n${source}\n${repo}`, at);
      webhooks.set(webhookKey(tenantId, source, repo), at);
    },
    stale(tenantId, source, repo, listedAt) {
      const at = now().getTime();
      const webhookAt = webhooks.get(webhookKey(tenantId, source, repo));
      if (webhookAt === undefined || at - webhookAt >= quietMs || at - listedAt >= quietMs) return true;
      const repoAt = repos.get(`${tenantId}\n${source}\n${repo}`);
      return repoAt !== undefined && repoAt + graceMs >= listedAt;
    },
  };
}
