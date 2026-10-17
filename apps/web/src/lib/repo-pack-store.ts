import type { Transport } from "@intx/hub-client";
import type { CheckPack, TriageStats } from "@corbits/triage-contracts";
import { writeCheckPack } from "./check-pack.ts";
import { loadRepoCheckPack, loadRepoPolicy, loadTriageStats, saveRepoSettings, type CheckPackArtifact } from "./hub-api.ts";
import type { DraftPolicy } from "./pack-draft.ts";

/** The artifact a write must land on. */
export type PackRef = { id: string; version: number };

/** A pack read from the policy file has no artifact to write to. */
export type PackArtifact = (PackRef & { pack: CheckPack }) | (PackRef & { corrupt: string }) | { pack: CheckPack };

export type LoadedRepoPack = { artifact: PackArtifact | null; policy: DraftPolicy };

export type RepoPackStore = {
  tenantId: string;
  /** `fresh` reads past any cache, which may predate the change that made a reload necessary. */
  load: (repo: string, fresh: boolean) => Promise<LoadedRepoPack>;
  /** Writes onto the artifact the pack was loaded from, or creates one when there was none; throws StaleCheckPackError otherwise. */
  writePack: (pack: CheckPack, loaded: PackRef | null) => Promise<PackRef>;
  writePolicy: (repo: string, policy: DraftPolicy, packId: string | null) => Promise<void>;
  loadStats: (repo: string, days: number) => Promise<TriageStats>;
};

export function packArtifact(found: CheckPackArtifact | null): PackArtifact | null {
  switch (found?.kind) {
    case "pack":
      return { id: found.id, version: found.version, pack: found.pack };
    case "corrupt":
      return { id: found.id, version: found.version, corrupt: found.reason };
    case "file":
      return { pack: found.pack };
    default:
      return null;
  }
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
