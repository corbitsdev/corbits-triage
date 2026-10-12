import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PrItem } from "./hub-api.ts";
import { allOpen, type OpenItem } from "./inbox-view.ts";
import { useActedPulls, useOpenPulls, useQueueLoading } from "./open-pulls.ts";
import { usePortal } from "./portal.tsx";
import { parseSavedPulse, resumeVisit, sinceVisit, stuckPulls, visitOf, type SavedPulse, type SinceVisit, type Visit, type VisitStart } from "./pulse.ts";
import { triageEnabledRepos } from "./repo-rows.ts";
import { useSession } from "./session.tsx";

const VISIT_QUERY_KEY = "pulse-visit";

const STORAGE_PREFIX = "corbits-triage:pulse:";

function storageKey(userId: string, tenantId: string): string {
  return `${STORAGE_PREFIX}${userId}:${tenantId}`;
}

/** Saved visits hold pull request titles, so they are removed when the session ends. */
export function forgetSavedVisits(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key?.startsWith(STORAGE_PREFIX)) storage.removeItem(key);
  }
}

function readSaved(key: string): SavedPulse | null {
  try {
    return parseSavedPulse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeSaved(key: string, saved: SavedPulse) {
  try {
    localStorage.setItem(key, JSON.stringify(saved));
  } catch {
    // Storage can be blocked (private mode, quota); the visit then lasts for this page only.
  }
}

/** `firstVisit` is true while the compared visit started on the user's first visit, so nothing can have changed yet. */
export type Pulse = { visit: Visit; firstVisit: boolean; since: SinceVisit; stuck: PrItem[]; acted: number };

type PulseState = {
  /** Null until GitHub answered on this page load and the last visit is read. */
  pulse: Pulse | null;
  /** Ends the visit: what is open now becomes what the next one is compared to. */
  endVisit: () => void;
  /** Saves what is open now, so a reload or a restored tab soon after carries this visit on. */
  saveVisit: () => void;
};

const PulseContext = createContext<PulseState | null>(null);

type VisitArea = "pulse" | "inbox";

function visitArea(path: string): VisitArea | null {
  if (path.startsWith("/pulse")) return "pulse";
  if (["/inbox", "/open", "/first-timers", "/triage"].some((root) => path.startsWith(root))) return "inbox";
  return null;
}

/** What changed since the user's last visit ended, projected once from the open pull requests the layout already holds. */
function usePulseState(open: OpenItem[]): PulseState {
  const { session } = useSession();
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const loading = useQueueLoading();
  const openPulls = useOpenPulls();
  const { acted, replace } = useActedPulls();
  const tenantId = snapshot?.workspace.tenantId;
  const storage = session && tenantId ? storageKey(session.id, tenantId) : null;
  const visitQueryKey = useMemo(() => [VISIT_QUERY_KEY, storage], [storage]);
  const { data: start } = useQuery({
    queryKey: visitQueryKey,
    queryFn: storage === null ? skipToken : function loadVisit(): VisitStart | null {
      const saved = readSaved(storage);
      return saved === null ? null : resumeVisit(saved, Date.now());
    },
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const entries = useMemo(() => allOpen(open, triageEnabledRepos(snapshot?.repos ?? [])), [open, snapshot]);
  const read = useMemo(function answeredRepos() {
    const enabled = triageEnabledRepos(snapshot?.repos ?? []);
    return new Set((openPulls.data?.repos ?? []).filter((repo) => repo.error === undefined && enabled.has(repo.repo)).map((repo) => repo.repo));
  }, [openPulls.data, snapshot]);
  // The open pull requests restored from IndexedDB may be stale, so nothing is compared or stored before GitHub answers.
  const answered = !loading && openPulls.isFetchedAfterMount;
  const ready = answered && start !== undefined;

  useEffect(function actedSinceVisitStart() {
    if (start) replace(start.acted);
  }, [start, replace]);

  const pulse = useMemo(function pulseSinceVisit() {
    if (!ready || start === null) return null;
    const visit = start.compared;
    return { visit, firstVisit: start.first, since: sinceVisit(visit, entries, read), stuck: stuckPulls(entries, Date.now()), acted: acted.length };
  }, [ready, start, entries, read, acted]);

  const latest = useCallback(function latest(): Visit | null {
    return answered && storage !== null ? visitOf(entries, read, new Date()) : null;
  }, [answered, entries, read, storage]);

  const restart = useCallback(function restart(first: boolean) {
    const now = latest();
    if (now === null || storage === null) return;
    const next = { compared: now, acted: [], first };
    writeSaved(storage, { ...next, latest: now });
    queryClient.setQueryData(visitQueryKey, next);
  }, [latest, queryClient, storage, visitQueryKey]);

  useEffect(function startFirstVisit() {
    if (ready && start === null) restart(true);
  }, [ready, start, restart]);

  const endVisit = useCallback(() => restart(false), [restart]);

  const saveVisit = useCallback(function saveVisit() {
    const now = latest();
    if (now === null || storage === null || !start) return;
    writeSaved(storage, { compared: start.compared, latest: now, acted, first: start.first });
  }, [acted, latest, start, storage]);

  return useMemo(() => ({ pulse, endVisit, saveVisit }), [pulse, endVisit, saveVisit]);
}

/**
 * A visit spans Pulse and the inbox and ends on leaving both. Closing or hiding the page stores it for the next load,
 * so a tab switch does not wipe the briefing being read.
 */
function useVisitEnds(path: string, { endVisit, saveVisit }: PulseState) {
  const area = visitArea(path);
  const previous = useRef(area);

  useEffect(function endVisitOnLeave() {
    const was = previous.current;
    previous.current = area;
    if (was !== null && area === null) endVisit();
  }, [area, endVisit]);

  useEffect(function saveVisitOnHide() {
    if (area === null) return;
    function onPageHide() {
      saveVisit();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") saveVisit();
    }
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return function stopListening() {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [area, saveVisit]);
}

export function PulseProvider({ open, path, children }: { open: OpenItem[]; path: string; children: ReactNode }) {
  const state = usePulseState(open);
  useVisitEnds(path, state);
  return <PulseContext.Provider value={state}>{children}</PulseContext.Provider>;
}

export function usePulse(): PulseState {
  const state = useContext(PulseContext);
  if (state === null) throw new Error("usePulse needs a PulseProvider.");
  return state;
}
