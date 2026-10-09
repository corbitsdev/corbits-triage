import { useCallback, useEffect, useMemo } from "react";
import { useIsRestoring, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { projectQueue, type PrItem } from "./hub-api.ts";
import { loadOpenPulls } from "./github-manifest.ts";
import { usePortal } from "./portal.tsx";
import { useRunLogs } from "./run-logs.ts";
import { useApprovals, useApprovalsFirstLoad, useRuns } from "./tenant-entities.ts";

/** Reads the open pull requests from GitHub, so PRs without a verdict still show up. */
export function useOpenPulls() {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  return useQuery({
    queryKey: ["open-pulls", tenantId],
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

/** Pull requests acted on from the inbox, by key, to the verdict run they answered; a newer verdict brings them back. */
type Handled = Record<string, string | null>;

const HANDLED_PULLS_QUERY_KEY = "handled-pulls";
/** Held actions can still be undone, so they stay in memory; a pull request moves to the persisted handled map once its send starts. */
const HELD_PULLS_QUERY_KEY = "held-pulls";

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

function withPull(handled: Handled | undefined, item: PrItem): Handled {
  return { ...handled, [item.key]: item.runId };
}

function withoutPull(handled: Handled | undefined, item: PrItem): Handled {
  return Object.fromEntries(Object.entries(handled ?? {}).filter(([key]) => key !== item.key));
}

function repoOf(key: string): string {
  return key.slice(0, key.lastIndexOf("#"));
}

/**
 * Forgets pull requests that closed or got a newer verdict, once the cache is restored and every source has loaded.
 * Only repositories GitHub just answered for are judged; one whose read failed says nothing about its pull requests.
 */
function usePruneHandled(items: PrItem[], handled: Handled) {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const restoring = useIsRestoring();
  const loading = useQueueLoading();
  const openPulls = useOpenPulls();
  const tenantId = snapshot?.workspace.tenantId;
  useEffect(function pruneHandled() {
    if (restoring || loading || openPulls.isError || openPulls.data === undefined) return;
    const read = new Set(openPulls.data.repos.filter((repo) => repo.error === undefined).map((repo) => repo.repo));
    const open = new Map(items.filter((item) => !item.closed).map((item) => [item.key, item.runId]));
    const live = Object.entries(handled).filter(([key, runId]) => !read.has(repoOf(key)) || (open.has(key) && open.get(key) === runId));
    if (live.length < Object.keys(handled).length) queryClient.setQueryData<Handled>(handledKey(tenantId), Object.fromEntries(live));
  }, [handled, items, loading, openPulls.data, openPulls.isError, queryClient, restoring, tenantId]);
}

function isHandled(handled: Handled, item: PrItem): boolean {
  return Object.hasOwn(handled, item.key) && handled[item.key] === item.runId;
}

type HandledPulls = { hold: (item: PrItem) => void; markHandled: (item: PrItem) => void; release: (item: PrItem) => void };

/**
 * Takes a pull request out of the inbox the moment it is acted on and keeps it out from the moment its send starts,
 * so a reload cannot offer it again; Undo or a failed send puts it back.
 */
export function useHandledPulls(): HandledPulls {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  return useMemo(function handledPulls() {
    function hold(item: PrItem) {
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withPull(held, item));
    }
    function markHandled(item: PrItem) {
      queryClient.setQueryData<Handled>(handledKey(tenantId), (handled) => withPull(handled, item));
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withoutPull(held, item));
    }
    function release(item: PrItem) {
      queryClient.setQueryData<Handled>(heldKey(tenantId), (held) => withoutPull(held, item));
      queryClient.setQueryData<Handled>(handledKey(tenantId), (handled) => withoutPull(handled, item));
    }
    return { hold, markHandled, release };
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

/** True until every source the queue is projected from has loaded; the lists are not meaningful before that. */
export function useQueueLoading(): boolean {
  const { pending } = useRunLogs();
  const approvals = useApprovals();
  const openPulls = useOpenPulls();
  return pending || approvals.loading || approvals.unavailable || openPulls.isLoading;
}

/** The global loading pulse: the queue's sources, without polling approvals on pages that do not show them. */
export function useQueueLoadingPulse(): boolean {
  const { pending } = useRunLogs();
  const approvalsLoading = useApprovalsFirstLoad();
  const openPulls = useOpenPulls();
  return pending || approvalsLoading || openPulls.isLoading;
}

/** The inbox: every open pull request, with its verdict when it has one, until it is acted on. */
export function useQueueItems(): PrItem[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const items = usePullRequestItems();
  const handled = useHandledQuery(handledKey(tenantId));
  const held = useHandledQuery(heldKey(tenantId));
  usePruneHandled(items, handled);
  return useMemo(() => items.filter((item) => !item.closed && !isHandled(handled, item) && !isHandled(held, item)), [items, handled, held]);
}
