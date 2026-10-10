import { useEffect, useMemo, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { emptyPack, repoPolicy } from "@corbits/triage-contracts";
import { writeCheckPack } from "./check-pack.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackQuery } from "./check-packs.ts";
import { loadRepoPolicy } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { changeCount, fromPack, validate, type DraftProblem, type RepoDraft } from "./pack-draft.ts";
import { shownReason } from "./pack-prose.ts";
import { usePortal, useSignOutWhenRejected } from "./portal.tsx";
import { openSession, saveDraft, type PackSession } from "./repo-pack-save.ts";
import { draftPolicy, packArtifact, transportRepoPackStore, type RepoPackStore } from "./repo-pack-store.ts";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The hub store, reading packs through the query cache the repositories table shares. */
function hubRepoPackStore(queryClient: QueryClient, tenantId: string): RepoPackStore {
  const transport = createHubTransport();
  const direct = transportRepoPackStore(transport, tenantId);
  return {
    ...direct,
    async load(repo, fresh) {
      const query = checkPackQuery(queryClient, tenantId, repo);
      if (fresh) {
        await queryClient.invalidateQueries({ queryKey: [CHECK_PACK_INDEX_QUERY_KEY, tenantId] });
        await queryClient.invalidateQueries({ queryKey: query.queryKey });
      }
      const [found, policy] = await Promise.all([queryClient.fetchQuery(query), loadRepoPolicy(transport, tenantId, repo)]);
      return { artifact: packArtifact(found), policy: draftPolicy(policy) };
    },
    async writePack(pack, loaded) {
      const written = await writeCheckPack(transport, tenantId, pack.repo, pack, loaded);
      queryClient.setQueryData(checkPackQuery(queryClient, tenantId, pack.repo).queryKey, written);
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

export type RepoPack = {
  status: "loading" | "ready" | "failed";
  draft: RepoDraft;
  saved: RepoDraft;
  changes: number;
  /** The checks were written but the repository does not point at them yet; Save redoes the link. */
  unlinked: boolean;
  /** Why the draft cannot be saved as it stands, and where. */
  problem: DraftProblem | null;
  /** Why the newest artifact for the repository is not a check pack; saving replaces it in place. */
  corrupt: string | null;
  /** The pack changed on the hub since it was loaded; only a reload can save again. */
  stale: boolean;
  saving: boolean;
  error: string;
  edit: (update: (draft: RepoDraft) => RepoDraft) => void;
  save: () => Promise<void>;
  discard: () => void;
  reload: () => void;
};

/** Loads a repository's pack and settings from the store and saves the panel's edits back through it. */
export function useRepoPack(store: RepoPackStore | null, repo: string): RepoPack {
  const { refreshNow, runBacklog, notify } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const [session, setSession] = useState<PackSession>(() => emptySession(repo));
  const [draft, setDraft] = useState<RepoDraft>(session.saved);
  const [status, setStatus] = useState<RepoPack["status"]>("loading");
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(function loadPack() {
    let cancelled = false;
    setStatus("loading");
    setError("");
    setStale(false);
    if (!store) return;
    async function load(from: RepoPackStore) {
      try {
        const next = openSession(repo, await from.load(repo, attempt > 0));
        if (cancelled) return;
        setSession(next);
        setDraft(next.saved);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        signOutWhenRejected(cause);
        setError(`Could not load the check pack. ${messageOf(cause)}`);
        setStatus("failed");
      }
    }
    void load(store);
    return function cancel() {
      cancelled = true;
    };
  }, [store, repo, attempt]);

  async function startTriage() {
    try {
      await runBacklog(repo, "Triage enabled. Triaging open pull requests.");
    } catch (cause) {
      setError(`Triage enabled. Could not start triage of open pull requests. ${messageOf(cause)}`);
    }
  }

  async function save() {
    if (!store || problem) return;
    setSaving(true);
    setError("");
    setStale(false);
    const { session: next, draft: shown, failure } = await saveDraft(store, repo, session, draft);
    setSession(next);
    setDraft(shown);
    setSaving(false);
    if (failure) {
      signOutWhenRejected(failure.cause);
      setStale(failure.stale);
      setError(failure.message);
      return;
    }
    notify("Saved. Applies to the next pull request.");
    if (!session.saved.policy.enabled && draft.policy.enabled) await startTriage();
    try {
      await refreshNow();
    } catch (cause) {
      signOutWhenRejected(cause);
      setError(`Saved, but could not refresh. ${messageOf(cause)}`);
    }
  }

  function discard() {
    setDraft(session.saved);
  }

  function reload() {
    setAttempt((count) => count + 1);
  }

  const found = validate(draft);
  const problem = found && { ...found, reason: shownReason(found.reason, draft.pack) };

  return {
    status,
    draft,
    saved: session.saved,
    changes: changeCount(session.saved, draft),
    unlinked: session.unlinked,
    problem,
    corrupt: session.corrupt,
    stale,
    saving,
    error,
    edit: setDraft,
    save,
    discard,
    reload,
  };
}
