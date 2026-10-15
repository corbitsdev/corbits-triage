import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "@corbits/common";
import { queryOptions, skipToken, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { emptyPack, repoPolicy, type RepoSource } from "@corbits/triage-contracts";
import { isBitbucketDatacenterRepo, switchBitbucketDatacenterTriage } from "./bitbucket-datacenter.ts";
import { writeCheckPack } from "./check-pack.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackQuery } from "./check-packs.ts";
import { loadRepoPolicy } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { createAutosave, type Autosave, type AutosaveState, type DraftUpdate } from "./pack-autosave.ts";
import { fromPack, validate, type DraftProblem, type RepoDraft } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { usePortal, useSignOutWhenRejected } from "./portal.tsx";
import { openSession, saveDraft, unsavedChanges, type PackSession } from "./repo-pack-save.ts";
import { draftPolicy, packArtifact, transportRepoPackStore, type LoadedRepoPack, type RepoPackStore } from "./repo-pack-store.ts";

const REPO_POLICY_QUERY_KEY = "repo-policy";

function hubRepoPackStore(queryClient: QueryClient, tenantId: string): RepoPackStore {
  const transport = createHubTransport();
  const direct = transportRepoPackStore(transport, tenantId);
  return {
    ...direct,
    async load(repo, fresh) {
      const pack = checkPackQuery(tenantId, repo);
      const policy = queryOptions({ queryKey: [REPO_POLICY_QUERY_KEY, tenantId, repo], queryFn: () => loadRepoPolicy(transport, tenantId, repo) });
      if (fresh) {
        await queryClient.invalidateQueries({ queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId] });
        await queryClient.invalidateQueries({ queryKey: pack.queryKey });
        await queryClient.invalidateQueries({ queryKey: policy.queryKey });
      }
      const [found, settings] = await Promise.all([queryClient.fetchQuery(pack), queryClient.fetchQuery(policy)]);
      return { artifact: packArtifact(found), policy: draftPolicy(settings) };
    },
    async writePack(pack, loaded) {
      const written = await writeCheckPack(transport, tenantId, pack.repo, pack, loaded);
      queryClient.setQueryData(checkPackQuery(tenantId, pack.repo).queryKey, written);
      return { id: written.id, version: written.version };
    },
    /** A Bitbucket Data Center repository is recorded, enabled and disabled by the hub's routes, after the pack it runs is saved. */
    async writePolicy(repo, policy, packId) {
      if (isBitbucketDatacenterRepo(queryClient, tenantId, repo)) {
        const stored = await loadRepoPolicy(transport, tenantId, repo);
        if (stored.enabled !== policy.enabled) await switchBitbucketDatacenterTriage(queryClient, transport, tenantId, repo, policy.enabled);
      }
      await direct.writePolicy(repo, policy, packId);
    },
  };
}

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
  problem: DraftProblem | null;
  /** Why the newest artifact for the repository is not a check pack; the next save replaces it in place. */
  corrupt: string | null;
  error: string;
  conflicts: string[];
  edit: (update: DraftUpdate) => void;
  flush: () => void;
  reload: () => void;
};

type SaveInput = { session: PackSession; draft: RepoDraft };

export function useRepoPack(store: RepoPackStore | null, repo: string, source: RepoSource): RepoPack {
  const { refreshNow, runBacklog } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AutosaveState | null>(null);
  const [opened, setOpened] = useState<{ from: LoadedRepoPack; autosave: Autosave } | null>(null);
  const [afterError, setAfterError] = useState("");

  async function loadPack(from: RepoPackStore, fresh: boolean): Promise<LoadedRepoPack> {
    try {
      return await from.load(repo, fresh);
    } catch (cause) {
      signOutWhenRejected(cause);
      throw cause;
    }
  }

  const loaded = useQuery({
    queryKey: ["repo-pack-session", store?.tenantId, repo, attempt],
    queryFn: store ? () => loadPack(store, attempt > 0) : skipToken,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  async function writeDraft({ session, draft }: SaveInput) {
    if (!store) throw new Error("The workspace is not known yet.");
    return saveDraft(store, repo, session, draft);
  }

  const save = useMutation({ mutationFn: writeDraft });

  async function reread(): Promise<PackSession> {
    if (!store) throw new Error("The workspace is not known yet.");
    return openSession(repo, await loadPack(store, true));
  }

  /** Turning triage on starts triage of the open pull requests; every save refreshes the portal. */
  async function afterSave(before: PackSession, after: PackSession) {
    setAfterError("");
    try {
      // Open pull requests are triaged on turning on through GitHub's backlog route only.
      if (source === "github" && !before.saved.policy.enabled && after.saved.policy.enabled) await runBacklog(repo, "Triage enabled. Triaging open pull requests.");
      await refreshNow();
    } catch (cause) {
      signOutWhenRejected(cause);
      setAfterError(`Saved, but ${errorText(cause)}`);
    }
  }

  // The autosave outlives this render, so it calls the newest portal callbacks and store rather than the first ones.
  const latest = useRef({ write: save.mutateAsync, reread, afterSave, failed: signOutWhenRejected });
  latest.current = { write: save.mutateAsync, reread, afterSave, failed: signOutWhenRejected };

  // A newly loaded pack starts a new autosave, set while rendering so the first frame already shows it.
  if (loaded.data && opened?.from !== loaded.data) {
    const autosave = createAutosave({
      session: openSession(repo, loaded.data),
      delayMs: SAVE_AFTER_MS,
      write: (session, draft) => latest.current.write({ session, draft }),
      reread: () => latest.current.reread(),
      changed: setState,
      afterSave: (before, after) => latest.current.afterSave(before, after),
      failed: (cause) => latest.current.failed(cause),
    });
    setOpened({ from: loaded.data, autosave });
    setState(autosave.state());
  }

  // Closing the panel or reloading saves what is still waiting rather than dropping it.
  useEffect(function saveWhatIsWaiting() {
    const autosave = opened?.autosave;
    return function flushOnClose() {
      if (autosave?.state().waiting) void autosave.flush();
    };
  }, [opened]);

  const session = state?.session ?? emptySession(repo);
  const draft = state?.draft ?? session.saved;
  const found = validate(draft, session.saved);
  const problem = found && { ...found, reason: shownReason(found.reason, draft.pack) };
  const loadError = loaded.error ? `Could not load the policy. ${errorText(loaded.error)}` : "";

  function status(): RepoPack["status"] {
    if (loaded.isError) return "failed";
    return opened && opened.from === loaded.data ? "ready" : "loading";
  }

  function saveState(): SaveState {
    if (state?.saving) return "saving";
    if (problem || state?.error) return "not-saved";
    return state?.waiting || unsavedChanges(session, draft) > 0 ? "saving" : "saved";
  }

  function edit(update: DraftUpdate) {
    opened?.autosave.edit(update);
  }

  function flush() {
    void opened?.autosave.flush();
  }

  function reload() {
    setAttempt((count) => count + 1);
  }

  return { status: status(), draft, saved: session.saved, save: saveState(), problem, corrupt: session.corrupt, error: loadError || state?.error || afterError, conflicts: state?.conflicts ?? [], edit, flush, reload };
}
