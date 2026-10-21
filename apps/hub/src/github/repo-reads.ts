// GitHub reads shared by a tenant's members, kept until a webhook or the hub's own write says the repository changed.
// A webhook that never arrives costs at most KEPT_MS of its scope: no read is served older than that.

/** `pulls` reads change with a repository's pull requests; `all` reads also with its checks and branches. */
export type ReadScope = "pulls" | "all";

/**
 * The open pull request listing changes only with webhooks the App receives. Details and merge states also follow commit
 * statuses, which it is not sent, and GitHub's API can answer behind its webhooks, so they are kept for a minute at most.
 */
export const KEPT_MS: Record<ReadScope, number> = { pulls: 10 * 60_000, all: 60_000 };

/** Kept reads past this many are dropped oldest first; details carry file patches. */
export const MAX_KEPT = 200;

/** Events that change only checks or branches, which leave the open pull requests as listed. */
const UNLISTED_EVENTS = new Set(["check_run", "check_suite", "status", "workflow_run", "workflow_job", "push"]);

export type RepoRead<T> = {
  scope: ReadScope;
  tenantId: string;
  /** `owner/name` on GitHub. */
  repo: string;
  key: string;
  /** A kept value this rejects is read again, e.g. a mergeability the host had not worked out yet. */
  usable?: (value: T) => boolean;
};

export type RepoReads = {
  /** `event` names the webhook; the hub's own writes name none and change every read of the repository. */
  changed(tenantId: string, repo: string, event?: string): void;
  read<T>(at: RepoRead<T>, readNow: () => Promise<T>): Promise<T>;
};

type Kept = { repo: string; scope: ReadScope; version: number; at: number; value: Promise<unknown> };

export function createRepoReads(now: () => Date): RepoReads {
  const versions = new Map<string, Record<ReadScope, number>>();
  const kept = new Map<string, Kept>();

  function versionOf(scope: ReadScope, repo: string): number {
    return versions.get(repo)?.[scope] ?? 0;
  }

  /** A repository with nothing kept needs no version: whatever is read next is newer than any change before it. */
  function sweep(at: number) {
    for (const [id, entry] of kept) if (at - entry.at >= KEPT_MS[entry.scope]) kept.delete(id);
    for (const id of kept.keys()) {
      if (kept.size <= MAX_KEPT) break;
      kept.delete(id);
    }
    const held = new Set([...kept.values()].map((entry) => entry.repo));
    for (const repo of versions.keys()) if (!held.has(repo)) versions.delete(repo);
  }

  async function readAndKeep<T>(id: string, entry: Omit<Kept, "at" | "value">, readNow: () => Promise<T>): Promise<T> {
    const reading: Kept = { ...entry, at: now().getTime(), value: readNow() };
    kept.delete(id);
    kept.set(id, reading);
    try {
      return (await reading.value) as T;
    } catch (err) {
      if (kept.get(id) === reading) kept.delete(id);
      throw err;
    }
  }

  return {
    changed(tenantId, repo, event) {
      const id = `${tenantId}\n${repo}`;
      const was = versions.get(id) ?? { pulls: 0, all: 0 };
      versions.set(id, { pulls: event !== undefined && UNLISTED_EVENTS.has(event) ? was.pulls : was.pulls + 1, all: was.all + 1 });
    },
    async read<T>({ scope, tenantId, repo, key, usable }: RepoRead<T>, readNow: () => Promise<T>): Promise<T> {
      sweep(now().getTime());
      const repoId = `${tenantId}\n${repo}`;
      const id = [scope, repoId, key].join("\n");
      const version = versionOf(scope, repoId);
      const entry = kept.get(id);
      if (entry?.version === version) {
        const value = (await entry.value) as T;
        if (!usable || usable(value)) return value;
      }
      return readAndKeep(id, { repo: repoId, scope, version }, readNow);
    },
  };
}
