import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@corbits/common";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { emptyPack, repoPolicy } from "@corbits/triage-contracts";
import { writeCheckPack } from "./check-pack.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackQuery } from "./check-packs.ts";
import { loadRepoPolicy } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { createAutosave, type Autosave, type AutosaveState, type DraftUpdate } from "./pack-autosave.ts";
import { fromPack, validate, type DraftProblem, type RepoDraft } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { usePortal, useSignOutWhenRejected } from "./portal.tsx";
import { openSession, unsavedChanges, type PackSession } from "./repo-pack-save.ts";
import { draftPolicy, packArtifact, transportRepoPackStore, type RepoPackStore } from "./repo-pack-store.ts";

/** The hub store, reading packs through the query cache the repositories table shares. */
function hubRepoPackStore(queryClient: QueryClient, tenantId: string): RepoPackStore {
  const transport = createHubTransport();
  const direct = transportRepoPackStore(transport, tenantId);
  return {
    ...direct,
    async load(repo, fresh) {
      const query = checkPackQuery(tenantId, repo);
      if (fresh) {
        await queryClient.invalidateQueries({ queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId] });
        await queryClient.invalidateQueries({ queryKey: query.queryKey });
      }
      const [found, policy] = await Promise.all([queryClient.fetchQuery(query), loadRepoPolicy(transport, tenantId, repo)]);
      return { artifact: packArtifact(found), policy: draftPolicy(policy) };
    },
    async writePack(pack, loaded) {
      const written = await writeCheckPack(transport, tenantId, pack.repo, pack, loaded);
      queryClient.setQueryData(checkPackQuery(tenantId, pack.repo).queryKey, written);
      return { id: written.id, version: written.version };
    },
  };
}

/** Null until the workspace is known. */
export function useHubRepoPackStore(): RepoPackStore | null {
  const queryClient = useQueryClient();
  const tenantId = usePortal().snapshot?.workspace.tenantId;
  return useMemo(function hubStore() {
    return tenantId ? hubRepoPackStore(queryClient, tenantId) : null;
  }, [queryClient, tenantId]);
}

function emptySession(repo: string): PackSession {
  return { loaded: null, corrupt: null, saved: fromPack(emptyPack(repo), draftPolicy(repoPolicy(undefined))), unlinked: false };
}

/** Typing settles for this long before the draft is saved. */
const SAVE_AFTER_MS = 500;

export type SaveState = "saved" | "saving" | "not-saved";

export type RepoPack = {
  status: "loading" | "ready" | "failed";
  draft: RepoDraft;
  saved: RepoDraft;
  save: SaveState;
  /** Why what can be saved still cannot be, and where. */
  problem: DraftProblem | null;
  /** Why the newest artifact for the repository is not a check pack; the next save replaces it in place. */
  corrupt: string | null;
  error: string;
  edit: (update: DraftUpdate) => void;
  /** Saves now; also how a failed save is tried again. */
  flush: () => void;
  reload: () => void;
};

/** Loads a repository's pack and settings and saves each edit shortly after it is made. */
export function useRepoPack(store: RepoPackStore | null, repo: string): RepoPack {
  const { refreshNow, runBacklog } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const [state, setState] = useState<AutosaveState | null>(null);
  const [status, setStatus] = useState<RepoPack["status"]>("loading");
  const [loadError, setLoadError] = useState("");
  const [afterError, setAfterError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const autosave = useRef<Autosave | null>(null);
  const hooks = useRef({ refreshNow, runBacklog, signOutWhenRejected });
  hooks.current = { refreshNow, runBacklog, signOutWhenRejected };

  /** Turning triage on starts triage of the open pull requests; every save refreshes the portal. */
  async function afterSave(before: PackSession, after: PackSession) {
    setAfterError("");
    try {
      if (!before.saved.policy.enabled && after.saved.policy.enabled) await hooks.current.runBacklog(repo, "Triage enabled. Triaging open pull requests.");
      await hooks.current.refreshNow();
    } catch (cause) {
      hooks.current.signOutWhenRejected(cause);
      setAfterError(`Saved, but ${errorText(cause)}`);
    }
  }

  useEffect(function loadPack() {
    let cancelled = false;
    setStatus("loading");
    setLoadError("");
    if (!store) return;
    async function load(from: RepoPackStore) {
      try {
        const session = openSession(repo, await from.load(repo, attempt > 0));
        if (cancelled) return;
        autosave.current = createAutosave({ store: from, repo, session, delayMs: SAVE_AFTER_MS, changed: setState, saved: afterSave });
        setState(autosave.current.state());
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        hooks.current.signOutWhenRejected(cause);
        setLoadError(`Could not load the policy. ${errorText(cause)}`);
        setStatus("failed");
      }
    }
    void load(store);
    return function saveWhatIsWaiting() {
      cancelled = true;
      const pending = autosave.current;
      autosave.current = null;
      if (pending?.state().waiting) void pending.flush();
    };
  }, [store, repo, attempt]);

  useEffect(function signOutOnRejectedSave() {
    if (state?.failure) hooks.current.signOutWhenRejected(state.failure);
  }, [state?.failure]);

  const session = state?.session ?? emptySession(repo);
  const draft = state?.draft ?? session.saved;
  const found = validate(draft, session.saved.pack);
  const problem = found && { ...found, reason: shownReason(found.reason, draft.pack) };
  const error = loadError || state?.error || afterError;

  function save(): SaveState {
    if (state?.saving) return "saving";
    if (problem || state?.error) return "not-saved";
    return state?.waiting || unsavedChanges(session, draft) > 0 ? "saving" : "saved";
  }

  function edit(update: DraftUpdate) {
    autosave.current?.edit(update);
  }

  function flush() {
    void autosave.current?.flush();
  }

  function reload() {
    setAttempt((count) => count + 1);
  }

  return { status, draft, saved: session.saved, save: save(), problem, corrupt: session.corrupt, error, edit, flush, reload };
}
