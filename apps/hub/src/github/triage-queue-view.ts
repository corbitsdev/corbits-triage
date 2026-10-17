// The coordinator's queue for one workspace, as the portal will show it: jobs
// waiting and workers running, each with its head, where it came from and how
// long it has waited.
import { type } from "arktype";
import type { Member } from "../integrations/app.js";
import type { Coordinator, TriageSource } from "./coordinator.js";

export const TRIAGE_QUEUE_PATH = "/api/integrations/triage-queue";

const TRIAGE_SOURCES = ["event", "retry", "reconcile"] as const satisfies readonly TriageSource[];

const QueuedJob = type({
  repo: "string",
  number: "number.integer > 0",
  headSha: "string",
  source: type.enumerated(...TRIAGE_SOURCES),
  workflow: "string",
  queuedAt: "string",
  ageMs: "number >= 0",
});
export const TriageQueue = type({
  queued: QueuedJob.array(),
  running: QueuedJob.and({ startedAt: "string", "runId?": "string" }).array(),
});

export type TriageQueueDeps = {
  coordinator: Pick<Coordinator, "snapshot">;
  now: () => Date;
};

function aged<J extends { queuedAt: string }>(job: J, at: number) {
  return { ...job, ageMs: Math.max(0, at - new Date(job.queuedAt).getTime()) };
}

export function createTriageQueueView(deps: TriageQueueDeps) {
  return async function handle({ tenantId }: Member): Promise<Response> {
    const at = deps.now().getTime();
    const { queued, running } = deps.coordinator.snapshot(tenantId);
    return Response.json({ queued: queued.map((job) => aged(job, at)), running: running.map((job) => aged(job, at)) } satisfies typeof TriageQueue.infer);
  };
}
