import type { ReconcileOutcome } from "./triage-reconciler.js";

export type ReconcileLoopOptions = {
  intervalMs: number;
  /** First retry after a pass that could not deliver; doubles up to `retryMaxMs`. A pass that left a head unrouted is repeated this soon, every time. */
  retryMs: number;
  retryMaxMs: number;
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (scheduled: unknown) => void;
  now?: () => number;
};

function cancelTimeout(scheduled: unknown): void {
  clearTimeout(scheduled as ReturnType<typeof setTimeout>);
}

/** Runs one pass at a time; a request during a pass runs one more pass after it. */
export function createReconcileLoop(
  reconcile: () => Promise<ReconcileOutcome>,
  options: ReconcileLoopOptions,
  log: (entry: Record<string, unknown>) => void,
) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? cancelTimeout;
  const now = options.now ?? Date.now;
  let running: Promise<void> | undefined;
  let again = false;
  let retryIn = options.retryMs;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The one early pass waiting to run; a request for a later one leaves it be. */
  let pending: { at: number; scheduled: unknown } | undefined;

  function retryKick(): void {
    pending = undefined;
    kick();
  }

  function retryAfter(ms: number): void {
    const at = now() + ms;
    if (pending && pending.at <= at) return;
    if (pending) cancel(pending.scheduled);
    const entry: { at: number; scheduled: unknown } = { at, scheduled: undefined };
    pending = entry;
    entry.scheduled = schedule(retryKick, ms);
  }

  /** The soonest of the backoff, while a pass could not deliver, a pass left a head unrouted, and the lift of a GitHub rate limit it ran into. */
  function delayOf(outcome: ReconcileOutcome): number | undefined {
    const delays: number[] = [];
    if (outcome.unrouted) delays.push(options.retryMs);
    if (outcome.retry) {
      delays.push(retryIn);
      retryIn = Math.min(retryIn * 2, options.retryMaxMs);
    } else {
      retryIn = options.retryMs;
    }
    if (outcome.retryAt !== undefined) delays.push(Math.max(0, outcome.retryAt - now()));
    return delays.length === 0 ? undefined : Math.min(...delays);
  }

  async function drain(): Promise<void> {
    do {
      again = false;
      try {
        const delay = delayOf(await reconcile());
        if (delay !== undefined) retryAfter(delay);
      } catch (err) {
        log({ level: "error", msg: "triage_reconcile_failed", error: String(err) });
      }
    } while (again);
    running = undefined;
  }

  function kick(): void {
    if (running) {
      again = true;
      return;
    }
    running = drain();
  }

  return {
    kick,
    start(): void {
      kick();
      timer = setInterval(kick, options.intervalMs);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      if (pending) cancel(pending.scheduled);
    },
  };
}
