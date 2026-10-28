import { type } from "arktype";

/**
 * Every wait the hub, the listener and the manager share, each its production value unless its variable overrides it.
 * The hub reads them once as it starts and publishes the workflows' share in each release, since a workflow's process
 * gets none of the hub's environment.
 */
export const TIMING_VARIABLES = {
  /** How long a listener's wake mail waits for a just-deployed manager to reach a sidecar before it fails. */
  managerReadyMs: "TRIAGE_MANAGER_READY_MS",
  /** How long a just-deployed manager may have no sidecar and still hold its pull request. */
  managerStartGraceMs: "TRIAGE_MANAGER_START_GRACE_MS",
  /** How long a manager whose head awaits CI or a reviewer waits between passes. */
  managerPollMs: "TRIAGE_MANAGER_POLL_MS",
  /** How often a wake mail checks whether the manager it wakes has reached its sidecar. */
  wakePollMs: "TRIAGE_WAKE_POLL_MS",
  /** How often the hub re-queues open pull requests whose head has no verdict. */
  reconcileIntervalMs: "TRIAGE_RECONCILE_INTERVAL_MS",
  /** The first retry of a reconcile pass that could not mail a listener, doubling up to its ceiling. */
  reconcileRetryMs: "TRIAGE_RECONCILE_RETRY_MS",
  /** Quiet time before a pull request's webhook events go out as one mail. */
  coalesceQuietMs: "TRIAGE_COALESCE_QUIET_MS",
  /** How often the hub checks whether each workspace's pull requests still reach a manager. */
  livenessIntervalMs: "TRIAGE_LIVENESS_INTERVAL_MS",
  /** How long a pull request may wait for a manager before the hub raises its alarm. */
  stalledAfterMs: "TRIAGE_STALLED_AFTER_MS",
} as const;

export type Timings = Record<keyof typeof TIMING_VARIABLES, number>;

export const DEFAULT_TIMINGS: Timings = {
  managerReadyMs: 2 * 60_000,
  managerStartGraceMs: 2 * 60_000,
  managerPollMs: 30_000,
  wakePollMs: 2_000,
  reconcileIntervalMs: 5 * 60_000,
  reconcileRetryMs: 15_000,
  coalesceQuietMs: 30_000,
  livenessIntervalMs: 60_000,
  stalledAfterMs: 5 * 60_000,
};

/** The waits the listener and manager run on, which the hub writes into their release. */
export const WorkflowTimings = type({ managerReadyMs: "number.integer > 0", managerPollMs: "number.integer > 0", wakePollMs: "number.integer > 0" });
export type WorkflowTimings = typeof WorkflowTimings.infer;

export function workflowTimings({ managerReadyMs, managerPollMs, wakePollMs }: Timings): WorkflowTimings {
  return { managerReadyMs, managerPollMs, wakePollMs };
}

/**
 * The timings `env` sets, each unset one its default. A value that is not a positive integer throws, as does a start
 * grace shorter than the ready window, since a manager keeps its pull request for as long as the listener waits for it.
 */
export function timingsFrom(env: Readonly<Record<string, string | undefined>>): Timings {
  const timings = { ...DEFAULT_TIMINGS };
  for (const [key, variable] of Object.entries(TIMING_VARIABLES) as [keyof Timings, string][]) {
    const value = env[variable];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${variable} must be a positive integer of milliseconds, not ${JSON.stringify(value)}`);
    timings[key] = Number(value);
  }
  if (timings.managerStartGraceMs < timings.managerReadyMs) {
    throw new Error(`${TIMING_VARIABLES.managerStartGraceMs} must be at least ${TIMING_VARIABLES.managerReadyMs}, ${timings.managerReadyMs} ms`);
  }
  return timings;
}
