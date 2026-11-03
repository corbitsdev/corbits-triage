export { cachedLoads } from "@corbits/common";

const SHA = /^[0-9a-f]{40}$/;

const REPO = /^[\w.~-]+\/[\w.~-]+$/;

export function plainSegments(value: string): boolean {
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function checkRepo(repo: string): void {
  if (!REPO.test(repo) || !plainSegments(repo)) throw new Error(`${repo} is not an owner/name repository`);
}

/** Refuses what would leave the host API path it is put in: a sha that is not a commit id, or a repository or file path with an empty, `.` or `..` segment. */
export function checkTarget(repo: string, sha: string, path?: string): void {
  if (!SHA.test(sha)) throw new Error(`sha must be 40 hex characters, got ${sha}`);
  checkRepo(repo);
  if (path !== undefined && !plainSegments(path)) throw new Error(`${path} is not a path relative to the repository root`);
}
