import { useQueries, useQuery, type Query, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  ApiError,
  listWorkflowDeployments,
  listWorkflowRuns,
  readWorkflowRunEvents,
  type Transport,
} from "@intx/hub-client";
import type { RunLog } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";

const RUN_IDS_QUERY_KEY = "run-ids";
export const RUN_LOG_QUERY_KEY = "run-log";
const LIVE_REFRESH_MS = 10_000;
const TERMINAL_EVENTS = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

type RunRef = { anchorRunId: string; runId: string };

function isMissing(cause: unknown): boolean {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 403);
}

async function listRunRefs(transport: Transport, tenantId: string): Promise<RunRef[]> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const perDeployment = await Promise.all(deployments.map(async function runsOf(deployment) {
    try {
      const runIds = await listWorkflowRuns(transport, tenantId, deployment.id);
      return runIds.map((runId) => ({ anchorRunId: deployment.id, runId }));
    } catch (cause) {
      if (isMissing(cause)) return [];
      throw cause;
    }
  }));
  const seen = new Set<string>();
  return perDeployment.flat().filter((ref) => !seen.has(ref.runId) && seen.add(ref.runId));
}

async function readLog(transport: Transport, tenantId: string, ref: RunRef): Promise<RunLog | null> {
  try {
    const log = await readWorkflowRunEvents(transport, tenantId, ref.anchorRunId, ref.runId);
    return { runId: log.runId, anchorRunId: ref.anchorRunId, events: log.events };
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

/** A finished run's log never changes again, so it is read once and kept. */
export function isFinishedLog(log: RunLog | null | undefined): boolean {
  return log?.events.some((event) => TERMINAL_EVENTS.has(event.type)) ?? false;
}

export function isFinishedRunLogQuery(query: Query): boolean {
  return query.queryKey[0] === RUN_LOG_QUERY_KEY && query.state.status === "success" && isFinishedLog(query.state.data as RunLog | null);
}

function staleTimeOf(query: Query): number {
  return isFinishedLog(query.state.data as RunLog | null) ? Infinity : 0;
}

function refetchIntervalOf(query: Query): number | false {
  return isFinishedLog(query.state.data as RunLog | null) ? false : LIVE_REFRESH_MS;
}

export type RunLogs = { logs: RunLog[]; pending: boolean; denied: boolean };

function combineLogs(results: Array<UseQueryResult<RunLog | null>>): { logs: RunLog[]; pending: boolean } {
  return {
    logs: results.map((result) => result.data).filter((log): log is RunLog => log !== null && log !== undefined),
    pending: results.some((result) => result.isPending),
  };
}

export function useRunLogs(tenantId: string | undefined): RunLogs {
  const refs = useQuery({
    queryKey: [RUN_IDS_QUERY_KEY, tenantId],
    queryFn: async function fetchRunRefs() {
      return listRunRefs(createHubTransport(), tenantId as string);
    },
    enabled: tenantId !== undefined,
    refetchInterval: LIVE_REFRESH_MS,
  });
  const logs = useQueries({
    queries: (refs.data ?? []).map(function logQuery(ref) {
      return {
        queryKey: [RUN_LOG_QUERY_KEY, tenantId, ref.anchorRunId, ref.runId],
        queryFn: async function fetchLog() {
          return readLog(createHubTransport(), tenantId as string, ref);
        },
        staleTime: staleTimeOf,
        refetchInterval: refetchIntervalOf,
        gcTime: Infinity,
      };
    }),
    combine: combineLogs,
  });
  return {
    logs: logs.logs,
    pending: refs.isPending || logs.pending,
    denied: refs.error instanceof ApiError && refs.error.status === 403,
  };
}

export async function invalidateRunLogs(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: [RUN_IDS_QUERY_KEY] }),
    queryClient.invalidateQueries({ queryKey: [RUN_LOG_QUERY_KEY] }),
  ]);
}
