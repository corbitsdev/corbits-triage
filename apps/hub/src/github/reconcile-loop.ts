/** Runs one pass at a time; a request during a pass runs one more pass after it. */
export function createReconcileLoop(reconcile: () => Promise<void>, intervalMs: number, log: (entry: Record<string, unknown>) => void) {
  let running: Promise<void> | undefined;
  let again = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function drain(): Promise<void> {
    do {
      again = false;
      try {
        await reconcile();
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
      timer = setInterval(kick, intervalMs);
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
