import type { RepoSource } from "@corbits/triage-contracts";

const HOST_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

export function hostName(source: RepoSource): string {
  return HOST_NAMES[source];
}

/** The pull request's page on its host: the one the hub listed, else GitHub's well-known one for a GitHub pull request. */
export function pullUrl(pull: { source: RepoSource; url: string | null; repo: string; number: number | null }): string | null {
  if (pull.url) return pull.url;
  return pull.source === "github" && pull.number !== null ? `https://github.com/${pull.repo}/pull/${pull.number}` : null;
}

export function viewOnHost(source: RepoSource): string {
  return `View on ${hostName(source)}`;
}
