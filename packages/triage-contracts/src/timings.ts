/** Every wait the hub runs Triage on, each its production value unless its variable overrides it. */
export const TIMING_VARIABLES = {
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
  reconcileIntervalMs: 5 * 60_000,
  reconcileRetryMs: 15_000,
  coalesceQuietMs: 30_000,
  livenessIntervalMs: 60_000,
  stalledAfterMs: 5 * 60_000,
};

/** The timings `env` sets, each unset one its default. A value that is not a positive integer throws. */
export function timingsFrom(env: Readonly<Record<string, string | undefined>>): Timings {
  const timings = { ...DEFAULT_TIMINGS };
  for (const [key, variable] of Object.entries(TIMING_VARIABLES) as [keyof Timings, string][]) {
    const value = env[variable];
    if (value === undefined) continue;
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${variable} must be a positive integer of milliseconds, not ${JSON.stringify(value)}`);
    timings[key] = Number(value);
  }
  return timings;
}
