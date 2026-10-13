import { errorText } from "@corbits/common";
import { validate, type RepoDraft } from "./pack-draft.ts";
import { openSession, saveDraft, type PackSession } from "./repo-pack-save.ts";
import type { RepoPackStore } from "./repo-pack-store.ts";

/** A change to the draft, written against whatever the draft is when it applies, so it can be replayed onto a newer pack. */
export type DraftUpdate = (draft: RepoDraft) => RepoDraft;

export type AutosaveState = { session: PackSession; draft: RepoDraft; saving: boolean; waiting: boolean; error: string; failure: unknown };

type AutosaveOptions = {
  store: RepoPackStore;
  repo: string;
  session: PackSession;
  delayMs: number;
  /** Called after every state change. */
  changed: (state: AutosaveState) => void;
  /** Called after each successful save with the session before and after it. */
  saved: (before: PackSession, after: PackSession) => Promise<void>;
};

export type Autosave = {
  state: () => AutosaveState;
  edit: (update: DraftUpdate) => void;
  /** Saves now; resolves once everything edited so far is saved or has failed. */
  flush: () => Promise<void>;
};

/**
 * Saves a repository's draft shortly after each edit, one save at a time. When the pack changed on the hub since it
 * was loaded, it is read again and the edits made since the last save are replayed onto it, keeping the other writer's
 * changes. The draft is never replaced by what was stored, so text being typed keeps its spacing.
 */
export function createAutosave({ store, repo, session, delayMs, changed, saved }: AutosaveOptions): Autosave {
  let state: AutosaveState = { session, draft: session.saved, saving: false, waiting: false, error: "", failure: null };
  /** Edits made since `state.session.saved`. */
  let pending: DraftUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> = Promise.resolve();
  /** Set before `run` starts and cleared when it ends, even when it ends without awaiting. */
  let busy = false;
  let again = false;

  function set(patch: Partial<AutosaveState>) {
    state = { ...state, ...patch };
    changed(state);
  }

  async function persist(): Promise<boolean> {
    const before = state.session;
    let sent = pending.length;
    let outcome = await saveDraft(store, repo, before, state.draft);
    if (outcome.failure?.stale) {
      const fresh = openSession(repo, await store.load(repo, true));
      set({ session: fresh, draft: pending.reduce((draft, update) => update(draft), fresh.saved) });
      sent = pending.length;
      outcome = await saveDraft(store, repo, fresh, state.draft);
    }
    if (outcome.failure) {
      set({ session: outcome.session, error: outcome.failure.message, failure: outcome.failure.cause });
      return false;
    }
    pending = pending.slice(sent);
    set({ session: outcome.session, error: "", failure: null });
    await saved(before, outcome.session);
    return true;
  }

  async function run() {
    set({ saving: true });
    try {
      do {
        again = false;
        if (validate(state.draft, state.session.saved.pack)) break;
        if (!(await persist())) break;
      } while (again);
    } catch (cause) {
      set({ error: `Could not save the policy. ${errorText(cause)}`, failure: cause });
    } finally {
      busy = false;
      set({ saving: false });
    }
  }

  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    if (state.waiting) set({ waiting: false });
    if (busy) {
      again = true;
      return running;
    }
    busy = true;
    running = run();
    return running;
  }

  function edit(update: DraftUpdate) {
    pending.push(update);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delayMs);
    set({ draft: update(state.draft), waiting: true });
  }

  return { state: () => state, edit, flush };
}
