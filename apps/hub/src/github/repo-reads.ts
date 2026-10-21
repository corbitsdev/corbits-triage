// GitHub reads shared by a tenant's members, kept until a webhook or the hub's own write says the repository changed.
// A webhook that never arrives costs at most SAFETY_MS: no read is served older than that.

export const SAFETY_MS = 10 * 60_000;

/** Events that change only checks or branches, which leave the open pull requests as listed. */
const UNLISTED_EVENTS = new Set(["check_run", "check_suite", "status", "workflow_run", "workflow_job", "push"]);

/** `pulls` reads change with a repository's pull requests; `all` reads also with its checks and branches. */
export type ReadScope = "pulls" | "all";

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

type Kept = { version: number; at: number; value: Promise<unknown> };

export function createRepoReads(now: () => Date): RepoReads {
  const versions = new Map<string, Record<ReadScope, number>>();
  const kept = new Map<string, Kept>();

  function versionOf(scope: ReadScope, tenantId: string, repo: string): number {
    return versions.get(`${tenantId}\n${repo}`)?.[scope] ?? 0;
  }

  function sweep(at: number) {
    for (const [id, entry] of kept) if (at - entry.at >= SAFETY_MS) kept.delete(id);
  }

  async function readAndKeep<T>(id: string, version: number, readNow: () => Promise<T>): Promise<T> {
    const entry: Kept = { version, at: now().getTime(), value: readNow() };
    kept.set(id, entry);
    try {
      return (await entry.value) as T;
    } catch (err) {
      if (kept.get(id) === entry) kept.delete(id);
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
      const id = [scope, tenantId, repo, key].join("\n");
      const version = versionOf(scope, tenantId, repo);
      const entry = kept.get(id);
      if (entry?.version === version) {
        const value = (await entry.value) as T;
        if (!usable || usable(value)) return value;
      }
      return readAndKeep(id, version, readNow);
    },
  };
}
