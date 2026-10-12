import { queryOptions, skipToken, useQueries, useQuery, useQueryClient, type Query, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, isTerminalRunEvents, listWorkflowDeployments, listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import { isEndedDeployment, isLiveRun, isSettledRunStatus, type HubRun, type RunLog, type Workspace } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { RUN_IDS_QUERY_KEY, RUN_LOG_QUERY_KEY, RUNS_QUERY_KEY, UNCHANGING_QUERY_META, usePortal } from "./portal.tsx";

const RUN_LIST_REFRESH_MS = 3_000;
/** Stock hub-client's run session rereads a live run's log at this cadence, so a verdict shows within seconds of landing. */
const LIVE_LOG_REFRESH_MS = 2_000;
const IDLE_LOG_REFRESH_MS = 10_000;

type RunRef = { anchorRunId: string; runId: string };

/** The run lists, per tenant and per ended deployment. */
export function isRunListQuery(query: Query): boolean {
  return query.queryKey[0] === RUN_IDS_QUERY_KEY;
}

/** The anchor run's own log only spawns children and never ends, so it is not read. */
async function listRuns(transport: Transport, tenantId: string, anchorRunId: string): Promise<RunRef[]> {
  const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
  return runIds.filter((runId) => runId !== anchorRunId).map((runId) => ({ anchorRunId, runId }));
}

/** A deployment the caller cannot read, or one removed since it was listed, contributes no runs. */
async function unlessDenied(read: () => Promise<RunRef[]>): Promise<RunRef[]> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return [];
    throw cause;
  }
}

/**
 * A released or failed deployment, or one whose anchor run has settled, starts no more runs, so its list is read once and kept,
 * per principal, and a refresh never rereads it. A denied read is not kept, so it is read again once access is granted.
 */
function endedDeploymentRunsQuery(transport: Transport, workspace: Workspace, anchorRunId: string) {
  return queryOptions({
    queryKey: [RUN_IDS_QUERY_KEY, workspace.tenantId, workspace.principalId, anchorRunId],
    queryFn: () => listRuns(transport, workspace.tenantId, anchorRunId),
    staleTime: Infinity,
    gcTime: Infinity,
    meta: UNCHANGING_QUERY_META,
  });
}

async function listRunRefs(queryClient: QueryClient, transport: Transport, workspace: Workspace): Promise<RunRef[]> {
  const { tenantId } = workspace;
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const runs = queryClient.getQueryData<HubRun[]>([RUNS_QUERY_KEY, tenantId]) ?? [];
  const settledAnchors = new Set(runs.filter((run) => isSettledRunStatus(run.status)).map((run) => run.id));
  const refs = await Promise.all(deployments.map((deployment) => unlessDenied(isEndedDeployment(deployment.status) || settledAnchors.has(deployment.id)
    ? () => queryClient.fetchQuery(endedDeploymentRunsQuery(transport, workspace, deployment.id))
    : () => listRuns(transport, tenantId, deployment.id))));
  const byRunId = new Map<string, RunRef>();
  for (const ref of refs.flat()) {
    if (!byRunId.has(ref.runId)) byRunId.set(ref.runId, ref);
  }
  return [...byRunId.values()];
}

export function runRefsQuery(queryClient: QueryClient, transport: Transport, workspace: Workspace | undefined) {
  return queryOptions({
    queryKey: [RUN_IDS_QUERY_KEY, workspace?.tenantId],
    queryFn: workspace === undefined ? skipToken : () => listRunRefs(queryClient, transport, workspace),
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

export function runLogQuery(queryClient: QueryClient, transport: Transport, tenantId: string, ref: RunRef) {
  function refreshMs(log: RunLog | undefined): number | false {
    if (log === undefined) return IDLE_LOG_REFRESH_MS;
    if (isEnded(log)) return false;
    const runs = queryClient.getQueryData<HubRun[]>([RUNS_QUERY_KEY, tenantId]) ?? [];
    return isLiveRun(log, runs, new Date()) ? LIVE_LOG_REFRESH_MS : IDLE_LOG_REFRESH_MS;
  }
  return queryOptions({
    queryKey: [RUN_LOG_QUERY_KEY, tenantId, ref.anchorRunId, ref.runId],
    queryFn: () => readLog(transport, tenantId, ref),
    // A finished run's log never changes again, so it is read once and kept.
    staleTime: (query) => refreshMs(query.state.data) || Infinity,
    refetchInterval: (query) => refreshMs(query.state.data),
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
  const refs = useQuery(runRefsQuery(queryClient, transport, snapshot?.workspace));
  const logs = useQueries({
    queries: tenantId === undefined || refs.data === undefined ? [] : refs.data.map((ref) => runLogQuery(queryClient, transport, tenantId, ref)),
    combine: loadedLogs,
  });
  return {
    logs: logs.logs,
    pending: refs.isLoading || logs.pending,
    denied: refs.error instanceof ApiError && refs.error.status === 403,
  };
}
