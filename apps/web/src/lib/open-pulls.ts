import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
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

/** Every pull request with a verdict, including closed ones, for the pull request page. */
export function usePullRequestItems(): PrItem[] {
  const { logs } = useRunLogs();
  const runs = useRuns();
  const approvals = useApprovals();
  const { data } = useOpenPulls();
  return useMemo(() => projectQueue(logs, runs.rows, approvals.rows, data), [logs, runs.rows, approvals.rows, data]);
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
