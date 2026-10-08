import { queryOptions, skipToken, useQueries, useQuery, type Query, type UseQueryResult } from "@tanstack/react-query";
import { ApiError, listWorkflowDeployments, listWorkflowRuns, readWorkflowRunEvents, type Transport } from "@intx/hub-client";
import type { RunLog } from "./hub-api.ts";
import { createHubTransport } from "./hub-transport.ts";
import { RUN_IDS_QUERY_KEY, RUN_LOG_QUERY_KEY, usePortal } from "./portal.tsx";

const LIVE_REFRESH_MS = 10_000;
const TERMINAL_EVENTS = new Set(["RunCompleted", "RunFailed", "RunCancelled"]);

type RunRef = { anchorRunId: string; runId: string };

/** A deployment the caller cannot read, or one removed since it was listed, contributes no runs. */
async function runsOf(transport: Transport, tenantId: string, anchorRunId: string): Promise<RunRef[]> {
  try {
    const runIds = await listWorkflowRuns(transport, tenantId, anchorRunId);
    return runIds.map((runId) => ({ anchorRunId, runId }));
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) return [];
    throw cause;
  }
}

async function listRunRefs(transport: Transport, tenantId: string): Promise<RunRef[]> {
  const deployments = await listWorkflowDeployments(transport, tenantId);
  const refs = await Promise.all(deployments.map((deployment) => runsOf(transport, tenantId, deployment.id)));
  const byRunId = new Map<string, RunRef>();
  for (const ref of refs.flat()) {
    if (!byRunId.has(ref.runId)) byRunId.set(ref.runId, ref);
  }
  return [...byRunId.values()];
}

async function readLog(transport: Transport, tenantId: string, ref: RunRef): Promise<RunLog> {
  const log = await readWorkflowRunEvents(transport, tenantId, ref.anchorRunId, ref.runId);
  return { runId: log.runId, anchorRunId: ref.anchorRunId, events: log.events };
}

/** A finished run's log never changes again, so it is read once and kept. */
function isFinished(log: RunLog): boolean {
  return log.events.some((event) => TERMINAL_EVENTS.has(event.type));
}

function isRunLog(value: unknown): value is RunLog {
  return typeof value === "object" && value !== null && "events" in value && Array.isArray(value.events);
}

export function isFinishedRunLogQuery(query: Query): boolean {
  return query.queryKey[0] === RUN_LOG_QUERY_KEY && isRunLog(query.state.data) && isFinished(query.state.data);
}

function runLogQuery(tenantId: string, ref: RunRef) {
  return queryOptions({
    queryKey: [RUN_LOG_QUERY_KEY, tenantId, ref.anchorRunId, ref.runId],
    queryFn: () => readLog(createHubTransport(), tenantId, ref),
    staleTime: (query) => (query.state.data !== undefined && isFinished(query.state.data) ? Infinity : 0),
    refetchInterval: (query) => (query.state.data !== undefined && isFinished(query.state.data) ? false : LIVE_REFRESH_MS),
    gcTime: Infinity,
  });
}

function loadedLogs(results: Array<UseQueryResult<RunLog>>): RunLog[] {
  return results.flatMap((result) => (result.data === undefined ? [] : [result.data]));
}

export function useRunLogs(): { logs: RunLog[]; denied: boolean } {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const refs = useQuery({
    queryKey: [RUN_IDS_QUERY_KEY, tenantId],
    queryFn: tenantId === undefined ? skipToken : () => listRunRefs(createHubTransport(), tenantId),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const logs = useQueries({
    queries: tenantId === undefined || refs.data === undefined ? [] : refs.data.map((ref) => runLogQuery(tenantId, ref)),
    combine: loadedLogs,
  });
  return { logs, denied: refs.error instanceof ApiError && refs.error.status === 403 };
}
