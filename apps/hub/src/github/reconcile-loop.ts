import type { ReconcileOutcome } from "./triage-reconciler.js";

export type ReconcileLoopOptions = {
  intervalMs: number;
  /** First retry after a pass that could not deliver; doubles up to `retryMaxMs`. */
  retryMs: number;
  retryMaxMs: number;
  schedule?: (run: () => void, ms: number) => unknown;
};

/** Runs one pass at a time; a request during a pass runs one more pass after it. */
export function createReconcileLoop(
  reconcile: () => Promise<ReconcileOutcome>,
  options: ReconcileLoopOptions,
  log: (entry: Record<string, unknown>) => void,
) {
  const schedule = options.schedule ?? setTimeout;
  let running: Promise<void> | undefined;
  let again = false;
  let retryIn = options.retryMs;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function drain(): Promise<void> {
    do {
      again = false;
      try {
        const outcome = await reconcile();
        if (outcome.retry) {
          // The sidecar is still reconnecting after a restart: try again well before the interval.
          schedule(kick, retryIn);
          retryIn = Math.min(retryIn * 2, options.retryMaxMs);
        } else {
          retryIn = options.retryMs;
        }
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
    },
  };
}
