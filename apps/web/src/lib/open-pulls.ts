import { useCallback, useEffect, useMemo } from "react";
import { useIsRestoring, useQuery, useQueryClient, type Query, type UseQueryResult } from "@tanstack/react-query";
import { projectQueue, type PrItem, type PullTriage } from "./hub-api.ts";
import { repoOf, type HandledKind, type HandledMark, type OpenItem } from "./inbox-view.ts";
import { loadOpenPulls } from "./github-manifest.ts";
import { usePortal } from "./portal.tsx";
import { useApprovals, useApprovalsFirstLoad } from "./tenant-entities.ts";
import { usePullTriage, useTriageVerdicts } from "./triage-verdicts.ts";

const OPEN_PULLS_QUERY_KEY = "open-pulls";

const NO_PULLS: PullTriage[] = [];

export function isOpenPullsQuery(query: Query): boolean {
  return query.queryKey[0] === OPEN_PULLS_QUERY_KEY;
}

/** So PRs without a verdict still show up. */
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
type HandledEntry = { kind: HandledKind; activityAt: string | null; headSha: string | null };

export type Handled = Record<string, HandledEntry | string | null>;

const HANDLED_PULLS_QUERY_KEY = "handled-pulls";
/** Held actions can still be undone, so they stay in memory; a pull request moves to the persisted handled map once its send starts. */
const HELD_PULLS_QUERY_KEY = "held-pulls";
/** The pull requests acted on from the inbox since the last visit ended; kept in memory and saved with the visit. */
const ACTED_PULLS_QUERY_KEY = "acted-pulls";

/** Merged and closed pull requests leave every list, not just the inbox. */
const LEAVING: ReadonlySet<HandledKind | null> = new Set(["merge", "close"]);

export function leavesOpen(kind: HandledKind): boolean {
  return LEAVING.has(kind);
}

function handledKey(tenantId: string | undefined) {
  return [HANDLED_PULLS_QUERY_KEY, tenantId];
}

function heldKey(tenantId: string | undefined) {
  return [HELD_PULLS_QUERY_KEY, tenantId];
}

function actedKey(tenantId: string | undefined) {
  return [ACTED_PULLS_QUERY_KEY, tenantId];
}

function noneActed(): string[] {
  return [];
}

export function useActedPulls(): { acted: string[]; replace: (keys: string[]) => void } {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  const { data } = useQuery({ queryKey: actedKey(tenantId), queryFn: noneActed, staleTime: Infinity, gcTime: Infinity });
  const replace = useCallback(function replaceActed(keys: string[]) {
    queryClient.setQueryData<string[]>(actedKey(tenantId), keys);
  }, [queryClient, tenantId]);
  return { acted: data ?? [], replace };
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

/** Activity older than the entry's means the hub has not recorded it yet, not that the author went back in time. */
function isNewerActivity(entry: HandledEntry, item: PrItem): boolean {
  return item.activityAt !== null && (entry.activityAt === null || item.activityAt > entry.activityAt);
}

/** A head unknown on either side, as when a repository read failed, says nothing; author activity still counts. */
function isOtherHead(entry: HandledEntry, item: PrItem): boolean {
  return entry.headSha !== null && item.headSha !== null && entry.headSha !== item.headSha;
}

function handledMark(handled: Handled, item: PrItem): HandledMark | null {
  if (!Object.hasOwn(handled, item.key)) return null;
  const entry = handled[item.key];
  if (entry === null || typeof entry === "string") return entry === item.runId ? { kind: null } : null;
  return isNewerActivity(entry, item) || isOtherHead(entry, item) ? null : { kind: entry.kind };
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
      queryClient.setQueryData<string[]>(actedKey(tenantId), (acted = []) => (acted.includes(item.key) ? acted : [...acted, item.key]));
    }
    function release(item: PrItem) {
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withoutPull(held, item));
      queryClient.setQueryData<Handled>(handledKey(tenantId), (handled) => withoutPull(handled, item));
      queryClient.setQueryData<string[]>(actedKey(tenantId), (acted = []) => acted.filter((key) => key !== item.key));
    }
    function sent(kind: HandledKind) {
      if (LEAVING.has(kind)) void queryClient.invalidateQueries({ queryKey: [OPEN_PULLS_QUERY_KEY, tenantId] });
    }
    return { hold, markHandled, release, sent };
  }, [queryClient, tenantId]);
}

function usePullRequestItems(pulls: PullTriage[] = NO_PULLS): PrItem[] {
  const verdicts = useTriageVerdicts();
  const approvals = useApprovals();
  const { data } = useOpenPulls();
  const sent = useSentReplies();
  return useMemo(function projectWithSentReplies() {
    const listed = verdicts.data?.pulls ?? NO_PULLS;
    const extra = pulls.filter((pull) => !listed.some((open) => open.repo === pull.repo && open.number === pull.number));
    const items = projectQueue([...listed, ...extra], approvals.rows, data);
    return items.map((item) => (item.runId !== null && sent[item.key] === item.runId ? { ...item, posted: true } : item));
  }, [verdicts.data, pulls, approvals.rows, data, sent]);
}

export function usePullPageItems(repo: string | null, number: number | null): PrItem[] {
  const verdicts = useTriageVerdicts();
  const openPulls = useOpenPulls();
  const named = (pull: { repo: string; number: number }) => pull.repo === repo && pull.number === number;
  const listed = verdicts.data?.pulls.some(named) === true;
  const open = openPulls.data?.repos.some((row) => row.repo === repo && row.prs.some((pr) => pr.number === number)) === true;
  const single = usePullTriage(repo ?? "", number, repo !== null && verdicts.data !== undefined && !listed && !open);
  return usePullRequestItems(single?.pulls);
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

/** The lists are not meaningful before that. */
export function useQueueLoading(): boolean {
  const { pending } = useTriageVerdicts();
  const approvals = useApprovals();
  const openPullsUnanswered = useOpenPullsUnanswered();
  return pending || approvals.loading || approvals.unavailable || openPullsUnanswered;
}

/** The global loading pulse: the queue's sources, without polling approvals on pages that do not show them. */
export function useQueueLoadingPulse(): boolean {
  const { pending } = useTriageVerdicts();
  const approvalsLoading = useApprovalsFirstLoad();
  const openPullsUnanswered = useOpenPullsUnanswered();
  return pending || approvalsLoading || openPullsUnanswered;
}

export function openItems(items: PrItem[], handled: Handled, held: Handled): OpenItem[] {
  return items
    .filter((item) => !item.closed)
    .map((item) => ({ item, handled: handledMark(held, item) ?? handledMark(handled, item) }))
    .filter((open) => !LEAVING.has(open.handled?.kind ?? null));
}

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

export function useQueueItems(): PrItem[] {
  const open = useOpenItems();
  return useMemo(() => open.filter((entry) => entry.handled === null).map((entry) => entry.item), [open]);
}
