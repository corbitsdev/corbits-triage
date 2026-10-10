import { useCallback, useEffect, useMemo } from "react";
import { useIsRestoring, useQuery, useQueryClient, type Query, type UseQueryResult } from "@tanstack/react-query";
import { projectQueue, type PrItem } from "./hub-api.ts";
import type { HandledKind, HandledMark, OpenItem } from "./inbox-view.ts";
import { loadOpenPulls } from "./github-manifest.ts";
import { usePortal } from "./portal.tsx";
import { useRunLogs } from "./run-logs.ts";
import { useApprovals, useApprovalsFirstLoad, useRuns } from "./tenant-entities.ts";

export const OPEN_PULLS_QUERY_KEY = "open-pulls";

export function isOpenPullsQuery(query: Query): boolean {
  return query.queryKey[0] === OPEN_PULLS_QUERY_KEY;
}

/** Reads the open pull requests from GitHub, so PRs without a verdict still show up. */
export function useOpenPulls() {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useQuery({
    queryKey: [OPEN_PULLS_QUERY_KEY, tenantId],
    queryFn: async function fetchOpenPulls() {
      return loadOpenPulls(tenantId ?? "");
    },
    enabled: tenantId !== undefined,
    refetchInterval: 30_000,
  });
}

/** Replies this portal sent, by pull request key, to the verdict run they answered; a newer verdict supersedes them. */
type SentReplies = Record<string, string>;

function sentRepliesKey(tenantId: string | undefined) {
  return ["sent-replies", tenantId];
}

function noSentReplies(): SentReplies {
  return {};
}

function useSentReplies(): SentReplies {
  const { snapshot } = usePortal();
  const { data } = useQuery({ queryKey: sentRepliesKey(snapshot?.workspace.tenantId), queryFn: noSentReplies, staleTime: Infinity });
  return data ?? {};
}

/** Marks a pull request's current verdict posted once the hub confirmed it wrote the reply. */
export function useMarkReplySent(): (item: PrItem) => void {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useCallback(function markReplySent(item: PrItem) {
    if (item.runId === null) return;
    const runId = item.runId;
    queryClient.setQueryData<SentReplies>(sentRepliesKey(tenantId), (sent) => ({ ...sent, [item.key]: runId }));
  }, [queryClient, tenantId]);
}

/**
 * What was done to a pull request from the inbox, against the author activity and head it answered; newer activity or another head brings it back.
 * `headSha` is null when the head was unknown at the time. A string or null is an entry stored before kinds were recorded: the verdict run it answered.
 */
export type HandledEntry = { kind: HandledKind; activityAt: string | null; headSha: string | null };

export type Handled = Record<string, HandledEntry | string | null>;

const HANDLED_PULLS_QUERY_KEY = "handled-pulls";
/** Held actions can still be undone, so they stay in memory; a pull request moves to the persisted handled map once its send starts. */
const HELD_PULLS_QUERY_KEY = "held-pulls";

/** Merged and closed pull requests leave every list, not just the inbox. */
const LEAVING: ReadonlySet<HandledKind | null> = new Set(["merge", "close"]);

/** All open keeps a pull request selected after an action, unless the action takes it out of the list. */
export function leavesOpen(kind: HandledKind): boolean {
  return LEAVING.has(kind);
}

function handledKey(tenantId: string | undefined) {
  return [HANDLED_PULLS_QUERY_KEY, tenantId];
}

function heldKey(tenantId: string | undefined) {
  return [HELD_PULLS_QUERY_KEY, tenantId];
}

/** Kept in IndexedDB, so an approved or commented pull request stays out of the inbox after a reload. */
export function isHandledPullsQuery(query: Query): boolean {
  return query.queryKey[0] === HANDLED_PULLS_QUERY_KEY;
}

function noneHandled(): Handled {
  return {};
}

function useHandledQuery(queryKey: Array<string | undefined>): Handled {
  const { data } = useQuery({ queryKey, queryFn: noneHandled, staleTime: Infinity, gcTime: Infinity });
  return data ?? {};
}

export function withPull(handled: Handled | undefined, item: PrItem, kind: HandledKind): Handled {
  return { ...handled, [item.key]: { kind, activityAt: item.activityAt, headSha: item.headSha } };
}

function withoutPull(handled: Handled | undefined, item: PrItem): Handled {
  return Object.fromEntries(Object.entries(handled ?? {}).filter(([key]) => key !== item.key));
}

/** Activity older than the entry's means its run log has not loaded yet, not that the author went back in time. */
function isNewerActivity(entry: HandledEntry, item: PrItem): boolean {
  return item.activityAt !== null && (entry.activityAt === null || item.activityAt > entry.activityAt);
}

/** A head unknown on either side, as when a repository read failed, says nothing; author activity still counts. */
function isOtherHead(entry: HandledEntry, item: PrItem): boolean {
  return entry.headSha !== null && item.headSha !== null && entry.headSha !== item.headSha;
}

/** The mark that keeps a pull request handled, while no author activity or push came after the entry. */
export function handledMark(handled: Handled, item: PrItem): HandledMark | null {
  if (!Object.hasOwn(handled, item.key)) return null;
  const entry = handled[item.key];
  if (entry === null || typeof entry === "string") return entry === item.runId ? { kind: null } : null;
  return isNewerActivity(entry, item) || isOtherHead(entry, item) ? null : { kind: entry.kind };
}

function repoOf(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

/**
 * Forgets pull requests that closed or that the author moved since, once every source has loaded and GitHub answered in this session;
 * a list restored from the cache may be stale. Only repositories GitHub just answered for are judged; one whose read failed
 * says nothing about its pull requests.
 */
function usePruneHandled(items: PrItem[], handled: Handled) {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const restoring = useIsRestoring();
  const loading = useQueueLoading();
  const openPulls = useOpenPulls();
  const tenantId = snapshot?.workspace.tenantId;
  useEffect(function pruneHandled() {
    if (restoring || loading || !openPulls.isFetchedAfterMount || openPulls.isError || openPulls.data === undefined) return;
    const read = new Set(openPulls.data.repos.filter((repo) => repo.error === undefined).map((repo) => repo.repo));
    const open = new Map(items.filter((item) => !item.closed).map((item) => [item.key, item]));
    const live = Object.entries(handled).filter(function stillHandled([key]) {
      const item = open.get(key);
      return !read.has(repoOf(key)) || (item !== undefined && handledMark(handled, item) !== null);
    });
    if (live.length < Object.keys(handled).length) queryClient.setQueryData<Handled>(handledKey(tenantId), Object.fromEntries(live));
  }, [handled, items, loading, openPulls.data, openPulls.isError, openPulls.isFetchedAfterMount, queryClient, restoring, tenantId]);
}

type HandledPulls = {
  hold: (item: PrItem, kind: HandledKind) => void;
  markHandled: (item: PrItem, kind: HandledKind) => void;
  release: (item: PrItem) => void;
  /** Once a merge or close reached GitHub, the open pull requests are read again so it leaves for good. */
  sent: (kind: HandledKind) => void;
};

/**
 * Takes a pull request out of the inbox the moment it is acted on and keeps it out from the moment its send starts,
 * so a reload cannot offer it again; Undo or a failed send puts it back.
 */
export function useHandledPulls(): HandledPulls {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useMemo(function handledPulls() {
    function hold(item: PrItem, kind: HandledKind) {
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withPull(held, item, kind));
    }
    function markHandled(item: PrItem, kind: HandledKind) {
      queryClient.setQueryData<Handled>(handledKey(tenantId), (handled) => withPull(handled, item, kind));
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withoutPull(held, item));
    }
    function release(item: PrItem) {
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withoutPull(held, item));
      queryClient.setQueryData<Handled>(handledKey(tenantId), (handled) => withoutPull(handled, item));
    }
    function sent(kind: HandledKind) {
      if (LEAVING.has(kind)) void queryClient.invalidateQueries({ queryKey: [OPEN_PULLS_QUERY_KEY, tenantId] });
    }
    return { hold, markHandled, release, sent };
  }, [queryClient, tenantId]);
}

/** Every pull request with a verdict, including closed ones, for the pull request page. */
export function usePullRequestItems(): PrItem[] {
  const { logs } = useRunLogs();
  const runs = useRuns();
  const approvals = useApprovals();
  const { data } = useOpenPulls();
  const sent = useSentReplies();
  return useMemo(function projectWithSentReplies() {
    const items = projectQueue(logs, runs.rows, approvals.rows, data, new Date());
    return items.map((item) => (item.runId !== null && sent[item.key] === item.runId ? { ...item, posted: true } : item));
  }, [logs, runs.rows, approvals.rows, data, sent]);
}

/**
 * Until GitHub first answers, every pull request with a verdict looks open, closed ones included.
 * A list restored from the cache counts as an answer and is refetched; a failed read counts too, so the inbox falls back to the verdicts it has.
 */
export function isOpenPullsAnswered(openPulls: Pick<UseQueryResult, "data" | "isError">): boolean {
  return openPulls.data !== undefined || openPulls.isError;
}

export function useOpenPullsUnanswered(): boolean {
  const openPulls = useOpenPulls();
  return openPulls.isEnabled && !isOpenPullsAnswered(openPulls);
}

/** True until every source the queue is projected from has loaded; the lists are not meaningful before that. */
export function useQueueLoading(): boolean {
  const { pending } = useRunLogs();
  const approvals = useApprovals();
  const openPullsUnanswered = useOpenPullsUnanswered();
  return pending || approvals.loading || approvals.unavailable || openPullsUnanswered;
}

/** The global loading pulse: the queue's sources, without polling approvals on pages that do not show them. */
export function useQueueLoadingPulse(): boolean {
  const { pending } = useRunLogs();
  const approvalsLoading = useApprovalsFirstLoad();
  const openPullsUnanswered = useOpenPullsUnanswered();
  return pending || approvalsLoading || openPullsUnanswered;
}

/** Open pull requests with their handled mark, held or sent; merged and closed ones are gone. */
export function openItems(items: PrItem[], handled: Handled, held: Handled): OpenItem[] {
  return items
    .filter((item) => !item.closed)
    .map((item) => ({ item, handled: handledMark(held, item) ?? handledMark(handled, item) }))
    .filter((open) => !LEAVING.has(open.handled?.kind ?? null));
}

/** Every open pull request, once GitHub has answered; the views apply their own rules on top. */
export function useOpenItems(): OpenItem[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const items = usePullRequestItems();
  const openPullsUnanswered = useOpenPullsUnanswered();
  const handled = useHandledQuery(handledKey(tenantId));
  const held = useHandledQuery(heldKey(tenantId));
  usePruneHandled(items, handled);
  return useMemo(function openWithMarks() {
    return openPullsUnanswered ? [] : openItems(items, handled, held);
  }, [items, openPullsUnanswered, handled, held]);
}

/** The inbox: every open pull request, with its verdict when it has one, until it is acted on. */
export function useQueueItems(): PrItem[] {
  const open = useOpenItems();
  return useMemo(() => open.filter((entry) => entry.handled === null).map((entry) => entry.item), [open]);
}
