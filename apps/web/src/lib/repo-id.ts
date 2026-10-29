import { repoSourceOf, type RepoSource } from "@corbits/triage-contracts";

/** A repository is its host and its name; the same name can be connected from both hosts, and no host means GitHub. */
export type RepoId = { name: string; source?: RepoSource };

export function sameRepo(a: RepoId, b: RepoId): boolean {
  return a.name === b.name && repoSourceOf(a.source) === repoSourceOf(b.source);
}

/** The key a repository sits under in a map or set, such as `useCheckPacks` or the inbox's enabled repositories. */
export function repoKey(repo: RepoId): string {
  return `${repoSourceOf(repo.source)}:${repo.name}`;
}
