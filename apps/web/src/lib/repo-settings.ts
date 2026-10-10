import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { emptyPack, repoPolicy, type CheckPack, type CleanupMode } from "@corbits/triage-contracts";
import { alreadyWritten, linkCheckPack, StaleCheckPackError, writeCheckPack, type LoadedCheckPack } from "./check-pack.ts";
import { CHECK_PACK_INDEX_QUERY_KEY, checkPackQuery } from "./check-packs.ts";
import type { RepoRecord, StoredCheckPack } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { changeCount, fromPack, packChanges, policyChanges, toPack, validate, type RepoDraft } from "./pack-draft.ts";
import { usePortal, useSignOutWhenRejected } from "./portal.tsx";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function startingDraft(repo: RepoRecord): RepoDraft {
  return fromPack(emptyPack(repo.name), repoPolicy(repo));
}

export type RepoSettings = {
  status: "loading" | "ready" | "failed";
  draft: RepoDraft;
  saved: RepoDraft;
  changes: number;
  /** The checks were written but the repository does not point at them yet; Save redoes the link. */
  unlinked: boolean;
  /** Why the draft cannot be saved as it stands. */
  blocked: string | null;
  /** No readable check pack yet; saving checks sets the repository up. */
  needsSetup: boolean;
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

/** Loads a repository's check pack and saves the panel's edits through the same pack and policy writes triage reads. */
export function useRepoSettings(repo: RepoRecord): RepoSettings {
  const queryClient = useQueryClient();
  const { snapshot, refreshNow, runBacklog, saveRepoPolicy, notify } = usePortal();
  const signOutWhenRejected = useSignOutWhenRejected();
  const tenantId = snapshot?.workspace.tenantId;
  const [saved, setSaved] = useState<RepoDraft>(() => startingDraft(repo));
  const [draft, setDraft] = useState<RepoDraft>(saved);
  const [status, setStatus] = useState<RepoSettings["status"]>("loading");
  const [loaded, setLoaded] = useState<LoadedCheckPack | null>(null);
  const [corrupt, setCorrupt] = useState<string | null>(null);
  /** A pack written to the hub whose config link failed; saving it again only redoes the link. */
  const [unlinked, setUnlinked] = useState<StoredCheckPack | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(function loadPack() {
    let cancelled = false;
    const start = startingDraft(repo);
    setStatus("loading");
    setError("");
    setStale(false);
    setUnlinked(null);
    setCorrupt(null);
    setLoaded(null);
    if (!tenantId) return;
    async function load(id: string) {
      try {
        const query = checkPackQuery(queryClient, id, repo.name);
        if (attempt > 0) {
          // Retry and Reload read past the cache, which may predate the change that made them necessary.
          await queryClient.invalidateQueries({ queryKey: [CHECK_PACK_INDEX_QUERY_KEY, id] });
          await queryClient.invalidateQueries({ queryKey: query.queryKey });
        }
        const found = await queryClient.fetchQuery(query);
        if (cancelled) return;
        const next = found?.kind === "pack" ? { ...start, pack: found.pack } : start;
        setSaved(next);
        setDraft(next);
        if (found) setLoaded({ id: found.id, version: found.version });
        setCorrupt(found?.kind === "corrupt" ? found.reason : null);
        setStatus("ready");
      } catch (cause) {
        if (cancelled) return;
        signOutWhenRejected(cause);
        setError(`Could not load the check pack. ${messageOf(cause)}`);
        setStatus("failed");
      }
    }
    void load(tenantId);
    return function cancel() {
      cancelled = true;
    };
  }, [repo.name, tenantId, attempt]);

  /** Writes the pack unless an earlier save already did, then links it; throws with what the user should do next. */
  async function savePack(tenant: string, pack: CheckPack, mode: CleanupMode) {
    const transport = createHubTransport();
    let written = alreadyWritten(unlinked, pack);
    try {
      if (!written) {
        written = await writeCheckPack(transport, tenant, repo.name, pack, loaded);
        queryClient.setQueryData(checkPackQuery(queryClient, tenant, repo.name).queryKey, written);
        setLoaded({ id: written.id, version: written.version });
        setCorrupt(null);
        setUnlinked(written);
        // The pack is in effect from here, so a later failure must not leave it counted as unsaved.
        const writtenPack = written.pack;
        setSaved((current) => ({ ...current, pack: writtenPack }));
        setDraft((current) => ({ ...current, pack: writtenPack }));
      }
      await linkCheckPack(transport, tenant, repo.name, mode);
      setUnlinked(null);
    } catch (cause) {
      signOutWhenRejected(cause);
      if (written) throw new Error(`The checks are saved and in effect, but could not be linked to the repository. Save again to link them. ${messageOf(cause)}`);
      if (cause instanceof StaleCheckPackError) {
        setStale(true);
        throw cause;
      }
      throw new Error(`Could not save the checks. ${messageOf(cause)} Check the values, then try again.`);
    }
  }

  function builtPack(current: RepoDraft): CheckPack {
    try {
      return toPack(current);
    } catch (cause) {
      throw new Error(`Could not save the checks. ${messageOf(cause)} Check the values, then try again.`);
    }
  }

  async function startTriage() {
    try {
      await runBacklog(repo.name, "Triage enabled. Triaging open pull requests.");
    } catch (cause) {
      setError(`Triage enabled. Could not start triage of open pull requests. ${messageOf(cause)}`);
    }
  }

  async function savePolicy() {
    try {
      await saveRepoPolicy(repo.name, { ...repoPolicy(repo), ...draft.policy });
    } catch (cause) {
      signOutWhenRejected(cause);
      throw new Error(`Could not save the posting and triage settings. ${messageOf(cause)}`);
    }
  }

  async function save() {
    if (!tenantId || blocked) return;
    setSaving(true);
    setError("");
    setStale(false);
    try {
      const pack = builtPack(draft);
      if (packChanges(saved.pack, draft.pack) > 0 || unlinked !== null) await savePack(tenantId, pack, draft.policy.cleanupMode);
      if (policyChanges(saved.policy, draft.policy) > 0) await savePolicy();
      setSaved((current) => ({ ...current, policy: draft.policy }));
    } catch (cause) {
      setError(messageOf(cause));
      setSaving(false);
      return;
    }
    setSaving(false);
    notify("Saved. Applies to the next pull request.");
    if (!saved.policy.enabled && draft.policy.enabled) await startTriage();
    try {
      await refreshNow();
    } catch (cause) {
      signOutWhenRejected(cause);
      setError(`Saved, but could not refresh. ${messageOf(cause)}`);
    }
  }

  function discard() {
    setDraft(saved);
  }

  function reload() {
    setAttempt((count) => count + 1);
  }

  const blocked = validate(draft)?.reason ?? null;

  return {
    status,
    draft,
    saved,
    changes: changeCount(saved, draft),
    unlinked: unlinked !== null,
    blocked,
    needsSetup: loaded === null || corrupt !== null,
    corrupt,
    stale,
    saving,
    error,
    edit: setDraft,
    save,
    discard,
    reload,
  };
}
