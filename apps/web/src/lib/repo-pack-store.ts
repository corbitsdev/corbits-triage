import type { Transport } from "@intx/hub-client";
import type { CheckPack, TriageStats } from "@corbits/triage-contracts";
import { writeCheckPack } from "./check-pack.ts";
import { loadRepoCheckPack, loadRepoPolicy, loadTriageStats, saveRepoSettings, type CheckPackArtifact } from "./hub-api.ts";
import type { DraftPolicy } from "./pack-draft.ts";

/** The artifact a write must land on. */
export type PackRef = { id: string; version: number };

/** The repository's newest pack artifact, or why it is not a check pack. */
export type PackArtifact = (PackRef & { pack: CheckPack }) | (PackRef & { corrupt: string });

export type LoadedRepoPack = { artifact: PackArtifact | null; policy: DraftPolicy };

/** Where the repository panel reads and writes its pack and settings. */
export type RepoPackStore = {
  tenantId: string;
  /** `fresh` reads past any cache, which may predate the change that made a reload necessary. */
  load: (repo: string, fresh: boolean) => Promise<LoadedRepoPack>;
  /** Writes onto the artifact the pack was loaded from, or creates one when there was none; throws StaleCheckPackError otherwise. */
  writePack: (pack: CheckPack, loaded: PackRef | null) => Promise<PackRef>;
  /** One config write with the settings, pinning the repository to the pack artifact `packId` when it has one. */
  writePolicy: (repo: string, policy: DraftPolicy, packId: string | null) => Promise<void>;
  loadStats: (repo: string, days: number) => Promise<TriageStats>;
};

export function packArtifact(found: CheckPackArtifact | null): PackArtifact | null {
  if (!found) return null;
  const { id, version } = found;
  return found.kind === "pack" ? { id, version, pack: found.pack } : { id, version, corrupt: found.reason };
}

export function draftPolicy(policy: DraftPolicy): DraftPolicy {
  const { enabled } = policy;
  return { enabled };
}

export function transportRepoPackStore(transport: Transport, tenantId: string): RepoPackStore {
  return {
    tenantId,
    async load(repo) {
      const [found, policy] = await Promise.all([loadRepoCheckPack(transport, tenantId, repo), loadRepoPolicy(transport, tenantId, repo)]);
      return { artifact: packArtifact(found), policy: draftPolicy(policy) };
    },
    async writePack(pack, loaded) {
      const { id, version } = await writeCheckPack(transport, tenantId, pack.repo, pack, loaded);
      return { id, version };
    },
    async writePolicy(repo, policy, packId) {
      await saveRepoSettings(transport, tenantId, repo, policy, packId);
    },
    async loadStats(repo, days) {
      return loadTriageStats(transport, tenantId, repo, days);
    },
  };
}
