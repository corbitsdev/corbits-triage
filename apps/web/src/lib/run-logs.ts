import { queryOptions, useQueries, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, isTerminalRunEvents, listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import { BACKLOG_WORKFLOW, type RunLog } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { RUN_IDS_QUERY_KEY, RUN_LOG_QUERY_KEY, usePortal } from "./portal.tsx";
import { useDeployedWorkflows } from "./tenant-entities.ts";

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

function deploymentRunsQuery(transport: Transport, tenantId: string, anchorRunId: string) {
  return queryOptions({
    queryKey: [RUN_IDS_QUERY_KEY, tenantId, anchorRunId],
    queryFn: () => runsOf(transport, tenantId, anchorRunId),
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

function runLogQuery(transport: Transport, tenantId: string, ref: RunRef) {
  return queryOptions({
    queryKey: [RUN_LOG_QUERY_KEY, tenantId, ref.anchorRunId, ref.runId],
    queryFn: () => readLog(transport, tenantId, ref),
    // A finished run's log never changes again, so it is read once and kept.
    staleTime: (query) => (isEnded(query.state.data) ? Infinity : LIVE_LOG_REFRESH_MS),
    refetchInterval: (query) => (isEnded(query.state.data) ? false : LIVE_LOG_REFRESH_MS),
    gcTime: Infinity,
  });
}

function loaded<T>(results: Array<UseQueryResult<T>>): T[] {
  return results.flatMap((result) => (result.data === undefined ? [] : [result.data]));
}

/** The logs of the backlog workflow's live deployments' runs, which say which repositories are catching up; no other list reads run logs. */
export function useBacklogLogs(): RunLog[] {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const transport = createHubTransport();
  const deployed = useDeployedWorkflows();
  const anchors = deployed.rows.filter((deployment) => deployment.workflow === BACKLOG_WORKFLOW).map((deployment) => deployment.id);
  const refs = useQueries({ queries: tenantId === undefined ? [] : anchors.map((anchor) => deploymentRunsQuery(transport, tenantId, anchor)), combine: loaded });
  return useQueries({ queries: tenantId === undefined ? [] : refs.flat().map((ref) => runLogQuery(transport, tenantId, ref)), combine: loaded });
}
