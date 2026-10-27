/** Where a repository's pull requests live; a record without one is on GitHub. */
export const REPO_SOURCES = ["github", "bitbucket-datacenter"] as const;
export type RepoSource = (typeof REPO_SOURCES)[number];

export function repoSourceOf(value: unknown): RepoSource {
  return value === "bitbucket-datacenter" ? value : "github";
}

/** Each host as the product names it in full, such as in Settings. */
export const HOST_FULL_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" };

/** What a person reads while a host runs no Triage, naming where to find out why. */
export function triageStopped(source: RepoSource): string {
  return `Triage is not running on ${HOST_FULL_NAMES[source]}. Settings, under Triage, shows why.`;
}
