import { emptyPack, repoPolicy, type CheckPack } from "@corbits/triage-contracts";
import { StaleCheckPackError } from "./check-pack.ts";
import { fromPack, packChanges, policyChanges, toPack, type RepoDraft } from "./pack-draft.ts";
import { draftPolicy, type LoadedRepoPack, type PackRef, type RepoPackStore } from "./repo-pack-store.ts";

/** What the hub holds for the repository, as far as the panel knows. */
export type PackSession = {
  /** The artifact the next pack write must land on. */
  loaded: PackRef | null;
  /** Why the newest artifact for the repository is not a check pack; a write replaces it in place. */
  corrupt: string | null;
  saved: RepoDraft;
  /** The pack was written but the config write that points at it failed; saving again redoes only that write. */
  unlinked: boolean;
};

export type SaveFailure = { message: string; cause: unknown; stale: boolean };

/** `draft` takes on what was written as stored, so normalising it leaves no phantom changes. */
export type SaveOutcome = { session: PackSession; draft: RepoDraft; failure: SaveFailure | null };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function openSession(repo: string, found: LoadedRepoPack): PackSession {
  const artifact = found.artifact;
  const pack = artifact && "pack" in artifact ? artifact.pack : emptyPack(repo);
  return {
    loaded: artifact ? { id: artifact.id, version: artifact.version } : null,
    corrupt: artifact && "corrupt" in artifact ? artifact.corrupt : null,
    saved: fromPack(pack, found.policy),
    unlinked: false,
  };
}

function checksFailed(cause: unknown): SaveFailure {
  return { message: `Could not save the checks. ${messageOf(cause)} Check the values, then try again.`, cause, stale: false };
}

/** Writes the pack when it changed, then one config write when anything is left to point at or change. */
export async function saveDraft(store: RepoPackStore, repo: string, session: PackSession, draft: RepoDraft): Promise<SaveOutcome> {
  let pack: CheckPack;
  try {
    pack = toPack(draft);
  } catch (cause) {
    return { session, draft, failure: checksFailed(cause) };
  }
  let current = session;
  let shown = draft;
  if (packChanges(session.saved.pack, draft.pack) > 0) {
    try {
      const loaded = await store.writePack(pack, session.loaded);
      current = { loaded, corrupt: null, saved: { ...session.saved, pack }, unlinked: true };
      shown = { ...draft, pack };
    } catch (cause) {
      if (cause instanceof StaleCheckPackError) return { session, draft, failure: { message: cause.message, cause, stale: true } };
      return { session, draft, failure: checksFailed(cause) };
    }
  }
  if (!current.unlinked && policyChanges(current.saved.policy, draft.policy) === 0) return { session: current, draft: shown, failure: null };
  const policy = draftPolicy(repoPolicy(draft.policy));
  try {
    await store.writePolicy(repo, policy, current.loaded !== null && current.corrupt === null);
  } catch (cause) {
    const message = current.unlinked
      ? `The checks are saved and in effect, but could not be linked to the repository. Save again to link them. ${messageOf(cause)}`
      : `Could not save the posting and triage settings. ${messageOf(cause)}`;
    return { session: current, draft: shown, failure: { message, cause, stale: false } };
  }
  const saved = { pack: current.saved.pack, policy };
  return { session: { ...current, saved, unlinked: false }, draft: saved, failure: null };
}
