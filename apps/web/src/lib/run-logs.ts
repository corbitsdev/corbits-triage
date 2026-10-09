import { queryOptions, skipToken, useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, isTerminalRunEvents, listWorkflowDeployments, listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import { isEndedDeployment, isSettledRunStatus, type HubRun, type RunLog } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { RUN_IDS_QUERY_KEY, RUN_LOG_QUERY_KEY, RUNS_QUERY_KEY, usePortal } from "./portal.tsx";

const RUN_LIST_REFRESH_MS = 10_000;
const LIVE_LOG_REFRESH_MS = 10_000;

type RunRef = { anchorRunId: string; runId: string };

/**
 * A deployment the caller cannot read, or one removed since it was listed, contributes no runs.
 * The anchor run's own log only spawns children and never ends, so it is not read.
 */
async function runsOf(transport: Transport, tenantId: string, anchorRunId: string): Promise<RunRef[]> {
  try {
    const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
    return runIds.filter((runId) => runId !== anchorRunId).map((runId) => ({ anchorRunId, runId }));
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return [];
    throw cause;
  }
}

/** A released or failed deployment, or one whose anchor run has settled, starts no more runs, so its list is read once and kept. */
function endedDeploymentRunsQuery(transport: Transport, tenantId: string, anchorRunId: string) {
  return queryOptions({
    queryKey: [RUN_IDS_QUERY_KEY, tenantId, anchorRunId],
    queryFn: () => runsOf(transport, tenantId, anchorRunId),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

async function listRunRefs(queryClient: QueryClient, transport: Transport, tenantId: string): Promise<RunRef[]> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const runs = queryClient.getQueryData<HubRun[]>([RUNS_QUERY_KEY, tenantId]) ?? [];
  const settledAnchors = new Set(runs.filter((run) => isSettledRunStatus(run.status)).map((run) => run.id));
  const refs = await Promise.all(deployments.map((deployment) => isEndedDeployment(deployment.status) || settledAnchors.has(deployment.id)
    ? queryClient.fetchQuery(endedDeploymentRunsQuery(transport, tenantId, deployment.id))
    : runsOf(transport, tenantId, deployment.id)));
  const byRunId = new Map<string, RunRef>();
  for (const ref of refs.flat()) {
    if (!byRunId.has(ref.runId)) byRunId.set(ref.runId, ref);
  }
  return [...byRunId.values()];
}

export function runRefsQuery(queryClient: QueryClient, transport: Transport, tenantId: string | undefined) {
  return queryOptions({
    queryKey: [RUN_IDS_QUERY_KEY, tenantId],
    queryFn: tenantId === undefined ? skipToken : () => listRunRefs(queryClient, transport, tenantId),
    staleTime: RUN_LIST_REFRESH_MS,
    refetchInterval: RUN_LIST_REFRESH_MS,
  });
}

async function readLog(transport: Transport, tenantId: string, ref: RunRef): Promise<RunLog> {
  const log = await readWorkflowRunEvents(transport, tenantId, ref.anchorRunId, ref.runId);
  return { runId: log.runId, anchorRunId: ref.anchorRunId, events: log.events };
}

function isEnded(log: RunLog | undefined): boolean {
  return log !== undefined && isTerminalRunEvents(log.events);
}

export function runLogQuery(transport: Transport, tenantId: string, ref: RunRef) {
  return queryOptions({
    queryKey: [RUN_LOG_QUERY_KEY, tenantId, ref.anchorRunId, ref.runId],
    queryFn: () => readLog(transport, tenantId, ref),
    // A finished run's log never changes again, so it is read once and kept.
    staleTime: (query) => (isEnded(query.state.data) ? Infinity : LIVE_LOG_REFRESH_MS),
    refetchInterval: (query) => (isEnded(query.state.data) ? false : LIVE_LOG_REFRESH_MS),
    gcTime: Infinity,
  });
}

type LoadedLogs = { logs: RunLog[]; pending: boolean };

function loadedLogs(results: Array<UseQueryResult<RunLog>>): LoadedLogs {
  return {
    logs: results.flatMap((result) => (result.data === undefined ? [] : [result.data])),
    pending: results.some((result) => result.isLoading),
  };
}

export function useRunLogs(): { logs: RunLog[]; pending: boolean; denied: boolean } {
  const { snapshot } = usePortal();
  const queryClient = useQueryClient();
  const tenantId = snapshot?.workspace.tenantId;
  const transport = createHubTransport();
  const refs = useQuery(runRefsQuery(queryClient, transport, tenantId));
  const logs = useQueries({
    queries: tenantId === undefined || refs.data === undefined ? [] : refs.data.map((ref) => runLogQuery(transport, tenantId, ref)),
    combine: loadedLogs,
  });
  return {
    logs: logs.logs,
    pending: refs.isLoading || logs.pending,
    denied: refs.error instanceof ApiError && refs.error.status === 403,
  };
}
