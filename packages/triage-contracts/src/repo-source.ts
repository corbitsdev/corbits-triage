/** Where a repository's pull requests live; a record without one is on GitHub. */
export const REPO_SOURCES = ["github", "bitbucket-datacenter"] as const;
export type RepoSource = (typeof REPO_SOURCES)[number];

export function repoSourceOf(value: unknown): RepoSource {
  return value === "bitbucket-datacenter" ? value : "github";
}

/** Each host as the product names it in full, such as in Settings. */
export const HOST_FULL_NAMES: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" };

/** What a person reads while a host runs no Triage, naming the button that starts it. */
export function triageStopped(source: RepoSource): string {
  return `Triage is stopped on ${HOST_FULL_NAMES[source]} until it is upgraded. Press Upgrade to new version in Settings.`;
}
