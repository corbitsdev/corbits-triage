/** Where a repository's pull requests live; a record without one is on GitHub. */
export const REPO_SOURCES = ["github", "bitbucket-datacenter"] as const;
export type RepoSource = (typeof REPO_SOURCES)[number];

export function repoSourceOf(value: unknown): RepoSource {
  return value === "bitbucket-datacenter" ? value : "github";
}
