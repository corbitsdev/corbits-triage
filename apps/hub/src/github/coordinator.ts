// One queue for the hub over the triage jobs the coalescer closes: each job is
// one pull request's folded mail, spawned as a fresh worker deployment and
// released when its one run ends. Capacity is the provisioner's: a spawn it
// refuses for want of room, or one with no listener to copy yet, waits and is
// retried. A queued job for a pull request whose head moved is replaced, not
// added, as the coalescer keys its windows, whichever workflow of its lane
// either names, and a deferred one a newer head replaced is dropped; a job for a pull request whose
// worker is still running waits for it, and the reconciler supersedes the old
// run's result. The queue lives in process: the hub runs as one replica, and
// the heads stay `queued` rows for the reconciler.
import { CODE_REVIEW_WORKFLOWS } from "./source-workflow.js";
import type { RepoRecord } from "./tenant-config.js";

/** Where a job came from; every source goes through the one queue. */
export type TriageSource = "event" | "retry" | "reconcile";

export type TriageJob = {
  tenantId: string;
  workflow: string;
  repo: string;
  number: number;
  headSha: string;
  source: TriageSource;
  payload: unknown;
  /** The repository a triage job's mail names, which the hub reads the pull request through. */
  record?: RepoRecord;
};

type JobView = Pick<TriageJob, "repo" | "number" | "headSha" | "source" | "workflow">;
export type QueuedJob = JobView & { queuedAt: string };
export type RunningJob = QueuedJob & { startedAt: string; runId?: string };

/** A spawn that cannot happen yet: the host has no room, or no listener to copy is live. The job is retried, not failed. */
export class WorkerDeferredError extends Error {}

export type WorkerSpawner = {
  /** Deploys a fresh worker and fires it with the job's mail; resolves with the worker's anchor run id. */
  spawn: (job: TriageJob) => Promise<string>;
  /** Resolves when the worker's one run has ended. */
  ended: (tenantId: string, runId: string) => Promise<void>;
  /** Releases the worker deployment once its run has ended. */
  release: (tenantId: string, runId: string) => Promise<void>;
};

export type CoordinatorDeps = {
  spawner: WorkerSpawner;
  /** How long a deferred job waits before its next spawn: doubled each time from `min`, never past `max`. */
  retry: { minMs: number; maxMs: number };
  /** The job's head is failed here when its worker could not be spawned or fired. */
  failed: (job: TriageJob, error: string) => Promise<void>;
  setTimer: (fire: () => Promise<void>, ms: number) => () => void;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
};

/** A started job; `runId` is set once the worker is spawned. */
type Running = { job: TriageJob; queuedAt: string; startedAt: string; runId?: string };

export type Coordinator = {
  enqueue: (job: TriageJob) => void;
  /** The tenant's jobs waiting and running, oldest first. */
  snapshot: (tenantId: string) => { queued: QueuedJob[]; running: RunningJob[] };
  /** Cancels the spawn timer; queued heads stay queued for the reconciler. */
  stop: () => void;
};

/** One job per pull request for its triage, whichever triage workflow it names, and one for its code review. */
function keyOf({ tenantId, workflow, repo, number }: TriageJob): string {
  const lane = CODE_REVIEW_WORKFLOWS.some((review) => review.id === workflow) ? "code-review" : "triage";
  return `${tenantId}\n${lane}\n${repo}\n${number}`;
}

function view(job: TriageJob): JobView {
  const { repo, number, headSha, source, workflow } = job;
  return { repo, number, headSha, source, workflow };
}

export function createCoordinator(deps: CoordinatorDeps): Coordinator {
  const queue = new Map<string, { job: TriageJob; queuedAt: string }>();
  const running = new Map<number, Running>();
  let slots = 0;
  /** Deferred jobs: how often, and when they may spawn again. */
  const refused = new Map<string, { attempts: number; notBefore: number }>();
  let cancelTimer: (() => void) | undefined;
  let pumping = false;
  let stopped = false;


  /** A newer head of the pull request is queued: the job it replaced is dropped, never run. */
  function superseded(job: TriageJob): boolean {
    const queued = queue.get(keyOf(job));
    return queued !== undefined && queued.job.headSha !== job.headSha;
  }

  function isRunning(job: TriageJob): boolean {
    for (const worker of running.values()) if (keyOf(worker.job) === keyOf(job)) return true;
    return false;
  }

  function next(now: number): { job?: TriageJob; waitMs?: number } {
    let waitMs: number | undefined;
    for (const { job } of queue.values()) {
      if (isRunning(job)) continue;
      const notBefore = refused.get(keyOf(job))?.notBefore ?? -Infinity;
      if (notBefore <= now) return { job };
      waitMs = Math.min(waitMs ?? Infinity, notBefore - now);
    }
    return { waitMs };
  }

  function requeue(job: TriageJob): void {
    const key = keyOf(job);
    if (queue.has(key)) return;
    queue.set(key, { job, queuedAt: deps.now().toISOString() });
  }

  function defer(job: TriageJob): number {
    const key = keyOf(job);
    const attempts = (refused.get(key)?.attempts ?? 0) + 1;
    const waitMs = Math.min(deps.retry.minMs * 2 ** (attempts - 1), deps.retry.maxMs);
    refused.set(key, { attempts, notBefore: deps.now().getTime() + waitMs });
    requeue(job);
    return waitMs;
  }

  async function failJob(job: TriageJob, error: string, entry: Record<string, unknown>): Promise<void> {
    try {
      await deps.failed(job, error);
    } catch (err) {
      deps.log({ level: "error", msg: "worker_fail_unrecorded", ...entry, error: String(err) });
    }
  }

  async function spawn(slot: number, job: TriageJob): Promise<void> {
    const entry = { tenantId: job.tenantId, repo: job.repo, pr: job.number, workflow: job.workflow };
    let runId: string;
    try {
      runId = await deps.spawner.spawn(job);
    } catch (err) {
      running.delete(slot);
      if (err instanceof WorkerDeferredError && superseded(job)) {
        refused.delete(keyOf(job));
        deps.log({ level: "info", msg: "worker_job_superseded", ...entry, headSha: job.headSha });
      } else if (err instanceof WorkerDeferredError) {
        deps.log({ level: "warn", msg: "worker_spawn_deferred", ...entry, error: String(err), retryMs: defer(job) });
      } else {
        deps.log({ level: "error", msg: "worker_spawn_failed", ...entry, error: String(err) });
        await failJob(job, `spawn failed: ${String(err)}`, entry);
      }
      void pump();
      return;
    }
    refused.delete(keyOf(job));
    running.set(slot, { ...running.get(slot)!, runId });
    deps.log({ level: "info", msg: "worker_spawned", ...entry, runId });
    try {
      await deps.spawner.ended(job.tenantId, runId);
    } catch (err) {
      deps.log({ level: "error", msg: "worker_wait_failed", ...entry, runId, error: String(err) });
    }
    try {
      await deps.spawner.release(job.tenantId, runId);
    } catch (err) {
      deps.log({ level: "error", msg: "worker_release_failed", ...entry, runId, error: String(err) });
    }
    running.delete(slot);
    deps.log({ level: "info", msg: "worker_ended", ...entry, runId });
    void pump();
  }

  function waitThenPump(ms: number): void {
    cancelTimer?.();
    cancelTimer = deps.setTimer(async function onSpawnSlot() {
      cancelTimer = undefined;
      await pump();
    }, ms);
  }

  async function pump(): Promise<void> {
    if (stopped || pumping) return;
    pumping = true;
    try {
      for (;;) {
        const { job, waitMs } = next(deps.now().getTime());
        if (!job) {
          if (waitMs !== undefined) waitThenPump(waitMs);
          return;
        }
        const { queuedAt } = queue.get(keyOf(job))!;
        queue.delete(keyOf(job));
        // Marks the pull request running through the spawn so a concurrent pump cannot start it twice.
        const slot = ++slots;
        running.set(slot, { job, queuedAt, startedAt: deps.now().toISOString() });
        void spawn(slot, job);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    enqueue(job) {
      // A newer job for a waiting pull request takes its place in line, not a new one.
      const key = keyOf(job);
      queue.set(key, { job, queuedAt: queue.get(key)?.queuedAt ?? deps.now().toISOString() });
      void pump();
    },
    snapshot(tenantId) {
      const queued = [...queue.values()].filter(({ job }) => job.tenantId === tenantId).map(({ job, queuedAt }) => ({ ...view(job), queuedAt }));
      const workers = [...running.values()].filter(({ job }) => job.tenantId === tenantId).map(({ job, queuedAt, startedAt, runId }) => ({ ...view(job), queuedAt, startedAt, ...(runId && { runId }) }));
      return { queued, running: workers };
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}
