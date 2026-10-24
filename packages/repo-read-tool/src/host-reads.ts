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

/** Runs each key's load once and shares its result; a load that fails is forgotten, so the next call tries again. */
export function cachedLoads<T>(): (key: string, run: () => Promise<T>) => Promise<T> {
  const loads = new Map<string, Promise<T>>();
  async function forgetOnFailure(key: string, pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (error) {
      loads.delete(key);
      throw error;
    }
  }
  return function load(key, run) {
    if (!loads.has(key)) loads.set(key, forgetOnFailure(key, run()));
    return loads.get(key)!;
  };
}
