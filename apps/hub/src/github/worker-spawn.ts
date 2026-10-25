// Spawns one worker deployment per triage job: a fresh copy of the host's
// live pr-triage listener (the seed), made the way rotation makes its copy and
// marked a worker in its deploy content, fired with exactly one mail. The
// worker keeps the listener shape, so its anchor stays live while the body
// run's log lands: the hub refuses a run log pushed after its anchor ended,
// which a one-run top-level deployment always does. The deployment is
// cancelled once that one body run has ended.
import { and, eq, ne, notInArray } from "drizzle-orm";
import { schema, type DB } from "@intx/db";
import { WorkflowProvisioningError, type WorkflowLifecycleService } from "@intx/hub-sessions";
import { CAPACITY_UNAVAILABLE } from "../sidecar/host-capacity.js";
import { NO_LISTENER_REASON, WorkerDeferredError, WorkerOutdatedError, type WorkerSpawner, type TriageJob } from "./coordinator.js";
import { DeploymentNotReadyError, liveWorkers, SenderRefusedError, resolveLiveDeployment, resolveLiveDeployments, retryUntilReady, WORKER_MARKER, type Redeployed } from "./deployment.js";

const WORKER_RELEASE_REASON = "Triage worker finished its run";
const RESTART_RELEASE_REASON = "Triage worker orphaned by a hub restart";

export type WorkerSpawnDeps = {
  db: DB["db"];
  /** Readies what the worker's credentials hold: a worker is deployed with them as they are. */
  beforeDeploy: (job: TriageJob) => Promise<void>;
  redeploy: (tenantId: string, seedAnchorRunId: string, content: Record<string, unknown>) => Promise<Redeployed>;
  deliver: (tenantId: string, address: string, payload: unknown) => Promise<void>;
  lifecycle: Pick<WorkflowLifecycleService, "requestCancellation" | "getStatus">;
  sleep: (ms: number) => Promise<void>;
  /** How long a fresh worker may take to accept its mail; the stock first-connect window is two minutes. */
  fireTimeoutMs: number;
  pollMs: number;
};

export function createWorkerSpawner(deps: WorkerSpawnDeps): WorkerSpawner {
  async function fire(job: TriageJob, runId: string): Promise<void> {
    await retryUntilReady(async function deliverToWorker() {
      const [worker] = (await resolveLiveDeployments(deps.db, job.tenantId, job.workflow, "worker")).filter((live) => live.runId === runId);
      if (!worker) throw new DeploymentNotReadyError();
      await deps.deliver(job.tenantId, worker.address, job.payload);
    }, { sleep: deps.sleep, pollMs: deps.pollMs, timeoutMs: deps.fireTimeoutMs });
  }

  async function spawn(job: TriageJob): Promise<string> {
    const seed = await resolveLiveDeployment(deps.db, job.tenantId, job.workflow);
    // The listener is being deployed or healed; the reconciler sees to it.
    if (!seed) throw new WorkerDeferredError(`no live ${job.workflow} listener to copy`, NO_LISTENER_REASON);
    await deps.beforeDeploy(job);
    let copy: Redeployed;
    try {
      copy = await deps.redeploy(job.tenantId, seed.runId, { [WORKER_MARKER]: true });
    } catch (err) {
      if (err instanceof WorkflowProvisioningError && err.code === CAPACITY_UNAVAILABLE) throw new WorkerDeferredError(err.message);
      throw err;
    }
    if (copy.status !== "deployed") throw new Error(`worker not deployed: ${copy.reason}`);
    try {
      await fire(job, copy.runId);
    } catch (err) {
      await deps.lifecycle.requestCancellation(job.tenantId, copy.runId, `Triage worker could not be fired: ${String(err)}`);
      if (err instanceof SenderRefusedError) throw new WorkerOutdatedError(err.message);
      throw err;
    }
    return copy.runId;
  }

  async function bodyEnded(runId: string): Promise<boolean> {
    const { workflowRun, liveWorkflowRunStatuses } = schema;
    const [row] = await deps.db
      .select({ id: workflowRun.id })
      .from(workflowRun)
      .where(and(eq(workflowRun.anchorRunId, runId), ne(workflowRun.id, runId), notInArray(workflowRun.status, [...liveWorkflowRunStatuses])))
      .limit(1);
    return row !== undefined;
  }

  async function anchorEnded(tenantId: string, runId: string): Promise<boolean> {
    const status = await deps.lifecycle.getStatus(tenantId, runId);
    return status === null || !schema.isLiveWorkflowRunStatus(status.status);
  }

  async function ended(tenantId: string, runId: string): Promise<void> {
    while (!(await bodyEnded(runId)) && !(await anchorEnded(tenantId, runId))) await deps.sleep(deps.pollMs);
  }

  async function release(tenantId: string, runId: string): Promise<void> {
    await deps.lifecycle.requestCancellation(tenantId, runId, WORKER_RELEASE_REASON);
  }

  return { spawn, ended, release };
}

/** A hub restart loses the queue that was waiting on its workers, so every worker still live is released. */
export async function releaseOrphanedWorkers(db: DB["db"], lifecycle: Pick<WorkflowLifecycleService, "requestCancellation">, log: (entry: Record<string, unknown>) => void): Promise<void> {
  for (const worker of await liveWorkers(db)) {
    try {
      await lifecycle.requestCancellation(worker.tenantId, worker.runId, RESTART_RELEASE_REASON);
      log({ level: "info", msg: "worker_released_on_start", ...worker });
    } catch (err) {
      log({ level: "error", msg: "worker_release_failed", ...worker, error: String(err) });
    }
  }
}
