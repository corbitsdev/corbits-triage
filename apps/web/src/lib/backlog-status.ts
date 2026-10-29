import type { TriageVerdicts } from "@corbits/triage-contracts";
import { sameRepo, type RepoId } from "./repo-id.ts";

/**
 * Repositories with no verdict yet whose pull requests have a manager's run going, each on its host; `triaged` are the
 * repositories that have a verdict.
 */
export function catchingUpRepos(pulls: TriageVerdicts["pulls"], triaged: readonly RepoId[]): RepoId[] {
  const repos: RepoId[] = [];
  for (const pull of pulls) {
    const repo = { name: pull.repo, source: pull.source };
    if (pull.run?.status === "running" && ![...triaged, ...repos].some((row) => sameRepo(row, repo))) repos.push(repo);
  }
  return repos;
}
