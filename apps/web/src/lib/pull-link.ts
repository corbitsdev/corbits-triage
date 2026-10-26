import type { RepoSource } from "@corbits/triage-contracts";

const HOST_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

const HOST_FULL_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" };

export function hostName(source: RepoSource): string {
  return HOST_NAMES[source];
}

/** Where the product is named, such as in Settings, Bitbucket Data Center is named in full. */
export function hostFullName(source: RepoSource): string {
  return HOST_FULL_NAMES[source];
}

/** The pull request's page on its host: the one the hub listed, else GitHub's well-known one for a GitHub pull request. */
export function pullUrl(pull: { source: RepoSource; url: string | null; repo: string; number: number | null }): string | null {
  if (pull.url) return pull.url;
  return pull.source === "github" && pull.number !== null ? `https://github.com/${pull.repo}/pull/${pull.number}` : null;
}

/** The host refuses a review from a pull request's author, so one Triage opened is reviewed there. */
export function viewOnHost(pull: { source: RepoSource; byTriage: boolean }): string {
  return `${pull.byTriage ? "Review" : "View"} on ${hostName(pull.source)}`;
}
