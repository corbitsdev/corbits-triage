import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

/** The inbox: every open pull request, with its verdict when it has one. */
export function useQueueItems(): PrItem[] {
  const items = usePullRequestItems();
  return useMemo(() => items.filter((item) => !item.closed), [items]);
}
