import { bitbucketCitationUrl, citationUrl, type LineCitation, type RepoSource } from "@corbits/triage-contracts";
import { bitbucketDatacenterRepoUrl } from "./bitbucket-datacenter.ts";

/** Without the Bitbucket instance's address there is no link, never a github.com one. */
export function evidenceUrl({ source, baseUrl, repo, sha, citation }: { source: RepoSource; baseUrl: string | undefined; repo: string; sha: string; citation: LineCitation }): string | undefined {
  if (source === "github") return citationUrl(repo, sha, citation);
  return baseUrl ? bitbucketCitationUrl(bitbucketDatacenterRepoUrl(baseUrl, repo), sha, citation) : undefined;
}
