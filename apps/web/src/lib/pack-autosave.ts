import { errorText } from "@corbits/common";
import { renamedRuleKeys, validate, type RepoDraft } from "./pack-draft.ts";
import { mergeDrafts, rekeyed } from "./pack-merge.ts";
import type { PackSession, SaveOutcome } from "./repo-pack-save.ts";

export type DraftUpdate = (draft: RepoDraft) => RepoDraft;

/** `conflicts` names what another writer also changed while this panel kept its own version, until the next edit. */
export type AutosaveState = { session: PackSession; draft: RepoDraft; saving: boolean; waiting: boolean; error: string; conflicts: string[] };

type AutosaveOptions = {
  session: PackSession;
  delayMs: number;
  write: (session: PackSession, draft: RepoDraft) => Promise<SaveOutcome>;
  reread: () => Promise<PackSession>;
  changed: (state: AutosaveState) => void;
  afterSave: (before: PackSession, after: PackSession) => Promise<void>;
  failed: (cause: unknown) => void;
};

export type Autosave = {
  state: () => AutosaveState;
  edit: (update: DraftUpdate) => void;
  flush: () => Promise<void>;
};

/** Rules saved for the first time take the ids they were saved under, and keep the key they were shown under. */
function withRenamedRules(draft: RepoDraft, renamed: Record<string, string>): RepoDraft {
  if (Object.keys(renamed).length === 0) return draft;
  return { ...draft, ruleKeys: renamedRuleKeys(draft.ruleKeys, renamed), pack: { ...draft.pack, custom: draft.pack.custom.map((row) => ({ ...row, id: renamed[row.id] ?? row.id })) } };
}

/**
 * Saves a repository's draft shortly after each edit, one save at a time. When another writer saved over the pack,
 * it is read again and what this panel changed since its last save is merged onto it, keeping the other writer's
 * changes and every unfinished row. The draft is never replaced by what was stored, so text being typed keeps its
 * spacing.
 */
export function createAutosave({ session, delayMs, write, reread, changed, afterSave, failed }: AutosaveOptions): Autosave {
  let state: AutosaveState = { session, draft: session.saved, saving: false, waiting: false, error: "", conflicts: [] };
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
    let outcome = await write(before, state.draft);
    if (outcome.failure?.stale) {
      const read = await reread();
      const fresh = { ...read, saved: rekeyed(before.saved, read.saved) };
      const merged = mergeDrafts(before.saved, state.draft, fresh.saved);
      set({ session: fresh, draft: merged.draft, conflicts: merged.conflicts });
      outcome = await write(fresh, state.draft);
    }
    if (outcome.failure) {
      failed(outcome.failure.cause);
      set({ session: outcome.session, error: outcome.failure.message });
      return false;
    }
    set({ session: outcome.session, draft: withRenamedRules(state.draft, outcome.renamed), error: "" });
    await afterSave(before, outcome.session);
    return true;
  }

  async function run() {
    set({ saving: true });
    try {
      do {
        again = false;
        if (validate(state.draft, state.session.saved)) break;
        if (!(await persist())) break;
      } while (again);
    } catch (cause) {
      failed(cause);
      set({ error: `Could not save the policy. ${errorText(cause)}` });
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), delayMs);
    set({ draft: update(state.draft), waiting: true, conflicts: [] });
  }

  return { state: () => state, edit, flush };
}
