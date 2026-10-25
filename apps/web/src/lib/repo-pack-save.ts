import { errorText } from "@corbits/common";
import { customRuleId, emptyPack, repoPolicy, VERDICTS, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { StaleCheckPackError } from "./check-pack.ts";
import { freshStepId, fromPack, packChanges, policyChanges, savable, stepEntries, storedStepKey, toPack, type RepoDraft } from "./pack-draft.ts";
import { draftPolicy, type LoadedRepoPack, type PackRef, type RepoPackStore } from "./repo-pack-store.ts";

export type PackSession = {
  /** The artifact the next pack write must land on. */
  loaded: PackRef | null;
  corrupt: string | null;
  saved: RepoDraft;
  /** The pack was written but the config write that points at it failed; saving again redoes only that write. */
  unlinked: boolean;
};

type SaveFailure = { message: string; cause: unknown; stale: boolean };

/**
 * The draft stays as typed; `session.saved` takes on what was written, as stored. `renamed` maps the ids of rules saved
 * for the first time to the ids they were saved under.
 */
export type SaveOutcome = { session: PackSession; renamed: Record<string, string>; failure: SaveFailure | null };

export function openSession(repo: string, found: LoadedRepoPack): PackSession {
  const artifact = found.artifact;
  const pack = artifact && "pack" in artifact ? artifact.pack : emptyPack(repo);
  return {
    loaded: artifact && "id" in artifact ? { id: artifact.id, version: artifact.version } : null,
    corrupt: artifact && "corrupt" in artifact ? artifact.corrupt : null,
    saved: fromPack(pack, found.policy),
    unlinked: false,
  };
}

/**
 * A rule saved for the first time takes its id from its text, as the `rule: <id>` label shows it on GitHub; a saved
 * rule keeps its id whatever it is renamed to.
 */
function namedNewRules(pack: CheckPack, saved: CheckPack, draft: CheckPack): { pack: CheckPack; renamed: Record<string, string> } {
  const kept = new Set(saved.custom.map((row) => row.id));
  const naming = new Set(pack.custom.filter((row) => !kept.has(row.id)).map((row) => row.id));
  // Rules still unfinished in the draft hold their ids too, so a rule named now never takes one of theirs.
  const taken = draft.custom.map((row) => row.id).filter((id) => !naming.has(id));
  const renamed: Record<string, string> = {};
  for (const row of pack.custom) {
    if (kept.has(row.id)) continue;
    const id = customRuleId(row.name, taken);
    taken.push(id);
    if (id !== row.id) renamed[row.id] = id;
  }
  return { pack: { ...pack, custom: pack.custom.map((row) => ({ ...row, id: renamed[row.id] ?? row.id })) }, renamed };
}

function stored(session: PackSession, draft: RepoDraft): { draft: RepoDraft; renamed: Record<string, string> } {
  const next = savable(draft, session.saved);
  const named = namedNewRules(toPack(next), session.saved.pack, draft.pack);
  const stepIds = Object.fromEntries(VERDICTS.map(function ids(list) {
    const unused = stepEntries(next, list).map((entry) => ({ id: entry.id, key: storedStepKey(next.pack.repo, list, entry.step) }));
    return [list, named.pack.actions[list].map(function idOf(step) {
      const key = storedStepKey(next.pack.repo, list, step);
      const at = unused.findIndex((entry) => entry.key === key);
      return at < 0 ? freshStepId() : unused.splice(at, 1)[0]!.id;
    })];
  })) as RepoDraft["stepIds"];
  return { draft: { pack: named.pack, policy: draftPolicy(repoPolicy(draft.policy)), stepIds }, renamed: named.renamed };
}

export function unsavedChanges(session: PackSession, draft: RepoDraft): number {
  try {
    const next = stored(session, draft).draft;
    return packChanges(session.saved.pack, next.pack) + policyChanges(session.saved.policy, next.policy) + Number(session.unlinked);
  } catch {
    return 1;
  }
}

function checksFailed(cause: unknown): SaveFailure {
  return { message: `Could not save the policy. ${errorText(cause)} Check the values, then try again.`, cause, stale: false };
}

/** Writes what of the draft can be saved: the pack when it changed or the stored one is corrupt, then one config write when anything is left to point at or change. */
export async function saveDraft(store: RepoPackStore, repo: string, source: RepoSource, session: PackSession, draft: RepoDraft): Promise<SaveOutcome> {
  let next: RepoDraft;
  let renamed: Record<string, string>;
  try {
    ({ draft: next, renamed } = stored(session, draft));
  } catch (cause) {
    return { session, renamed: {}, failure: checksFailed(cause) };
  }
  let current = session;
  if (packChanges(session.saved.pack, next.pack) > 0 || session.corrupt !== null) {
    try {
      const loaded = await store.writePack(next.pack, source, session.loaded);
      current = { loaded, corrupt: null, saved: { ...session.saved, pack: next.pack, stepIds: next.stepIds }, unlinked: true };
    } catch (cause) {
      if (cause instanceof StaleCheckPackError) return { session, renamed: {}, failure: { message: cause.message, cause, stale: true } };
      return { session, renamed: {}, failure: checksFailed(cause) };
    }
  }
  if (!current.unlinked && policyChanges(current.saved.policy, next.policy) === 0) return { session: current, renamed, failure: null };
  try {
    await store.writePolicy(repo, source, next.policy, current.corrupt === null && current.loaded !== null ? current.loaded.id : null);
  } catch (cause) {
    const message = current.unlinked
      ? `The policy is saved and in effect, but could not be linked to the repository. ${errorText(cause)}`
      : `Could not save the triage settings. ${errorText(cause)}`;
    return { session: current, renamed, failure: { message, cause, stale: false } };
  }
  return { session: { ...current, saved: { ...current.saved, policy: next.policy }, unlinked: false }, renamed, failure: null };
}
