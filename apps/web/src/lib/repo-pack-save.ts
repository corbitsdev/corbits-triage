import { errorText } from "@corbits/common";
import { emptyPack, repoPolicy, type CheckPack } from "@corbits/triage-contracts";
import { ExtendedPolicyError, StaleCheckPackError } from "./check-pack.ts";
import { fromPack, packChanges, policyChanges, savable, toPack, type DraftPolicy, type RepoDraft } from "./pack-draft.ts";
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

type SaveFailure = { message: string; cause: unknown; stale: boolean };

/** The draft stays as typed; `session.saved` takes on what was written, as stored. */
export type SaveOutcome = { session: PackSession; failure: SaveFailure | null };

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

/** What a save of `draft` would write, as stored; throws the contract's reason when it cannot be written. */
function stored(session: PackSession, draft: RepoDraft): { pack: CheckPack; policy: DraftPolicy } {
  return { pack: toPack(savable(draft, session.saved.pack)), policy: draftPolicy(repoPolicy(draft.policy)) };
}

/** Changes a save of `draft` would write; unfinished rows and spacing the contract trims are not changes. */
export function unsavedChanges(session: PackSession, draft: RepoDraft): number {
  try {
    const next = stored(session, draft);
    return packChanges(session.saved.pack, next.pack) + policyChanges(session.saved.policy, next.policy) + Number(session.unlinked);
  } catch {
    return 1;
  }
}

function checksFailed(cause: unknown): SaveFailure {
  return { message: `Could not save the policy. ${errorText(cause)} Check the values, then try again.`, cause, stale: false };
}

/** Writes what of the draft can be saved: the pack when it changed or the stored one is corrupt, then one config write when anything is left to point at or change. */
export async function saveDraft(store: RepoPackStore, repo: string, session: PackSession, draft: RepoDraft): Promise<SaveOutcome> {
  let next: { pack: CheckPack; policy: DraftPolicy };
  try {
    next = stored(session, draft);
  } catch (cause) {
    return { session, failure: checksFailed(cause) };
  }
  let current = session;
  if (packChanges(session.saved.pack, next.pack) > 0 || session.corrupt !== null) {
    try {
      const loaded = await store.writePack(next.pack, session.loaded);
      current = { loaded, corrupt: null, saved: { ...session.saved, pack: next.pack }, unlinked: true };
    } catch (cause) {
      if (cause instanceof StaleCheckPackError) return { session, failure: { message: cause.message, cause, stale: true } };
      if (cause instanceof ExtendedPolicyError) return { session, failure: { message: cause.message, cause, stale: false } };
      return { session, failure: checksFailed(cause) };
    }
  }
  if (!current.unlinked && policyChanges(current.saved.policy, next.policy) === 0) return { session: current, failure: null };
  try {
    await store.writePolicy(repo, next.policy, current.corrupt === null && current.loaded !== null ? current.loaded.id : null);
  } catch (cause) {
    const message = current.unlinked
      ? `The policy is saved and in effect, but could not be linked to the repository. ${errorText(cause)}`
      : `Could not save the triage settings. ${errorText(cause)}`;
    return { session: current, failure: { message, cause, stale: false } };
  }
  return { session: { ...current, saved: { pack: current.saved.pack, policy: next.policy }, unlinked: false }, failure: null };
}
