import { type } from "arktype";
import { getLogger } from "@intx/log";
import { ansiColorFormatter, configure, getConsoleSink, getJsonLinesFormatter, reset, type LogRecord, type Sink } from "@logtape/logtape";

const Correlation = type({
  tenantId: "0 < string <= 200",
  source: "'github' | 'bitbucket-datacenter'",
  repo: /^[\w.-]+\/[\w.-]+$/,
  number: "number.integer > 0",
  head: "0 < string <= 200",
  runId: "0 < string <= 200",
  "managerRunId?": "0 < string <= 200",
  kind: "'judge' | 'code-review'",
  msg: "'reviewer_result_accepted_success' | 'reviewer_result_accepted_failure' | 'reviewer_result_duplicate' | 'reviewer_result_stale' | 'reviewer_result_woken' | 'reviewer_result_unrouted' | 'reviewer_result_wake_failed'",
});
export type ReviewEvent = typeof Correlation.infer;
export type Destination = (event: Readonly<ReviewEvent>, signal: AbortSignal) => Promise<void>;
export type Destinations = {
  telemetry: readonly Destination[];
  errors: readonly Destination[];
  notifications: readonly Destination[];
};

const DestinationArrays = type({ telemetry: "Function[]", errors: "Function[]", notifications: "Function[]" });
const LoggingOptions = type({ development: "boolean" });

/** Deliberately excludes raw messages, exception objects and every unrecognized property. */
function project(entry: Record<string, unknown>): ReviewEvent | undefined {
  const { tenantId, source, repo, number, head, runId, managerRunId, kind, msg } = entry;
  const event = Correlation({ tenantId, source, repo, number, head, runId, kind, msg, ...(managerRunId !== undefined && { managerRunId }) });
  if (event instanceof type.errors || event.repo.length > 400) return undefined;
  return Object.freeze(event);
}

function diagnostic(reason: "overflow" | "timeout" | "failed" | "shutdown_deadline", destination: number): void {
  // Bypass LogTape: diagnostics must never recurse into the failing destination.
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg: "observability_delivery_dropped", reason, destination }));
}

/** In-memory best effort, one outstanding send per destination, including after timeout. */
export function createObservability(destinations: Destinations, { capacity = 64, timeoutMs = 2000, drainMs = 3000 } = {}) {
  DestinationArrays.assert(destinations);
  for (const value of [capacity, timeoutMs, drainMs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error("Observability limits must be positive integers");
  const workers = [
    ...destinations.telemetry.map((send) => ({ send, role: "telemetry" })),
    ...destinations.errors.map((send) => ({ send, role: "errors" })),
    ...destinations.notifications.map((send) => ({ send, role: "notifications" })),
  ].map(function worker({ send, role }, index) {
    const queue: ReviewEvent[] = [];
    let active: Promise<void> | undefined;
    let controller: AbortController | undefined;
    let disabled = false;
    let sending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let overflowReported = false;
    async function run(): Promise<void> {
      await Promise.resolve();
      while (queue.length && !disabled) {
        const event = queue.shift()!;
        sending = true;
        controller = new AbortController();
        const signal = controller.signal;
        function timeout(): void {
          disabled = true;
          queue.length = 0;
          controller?.abort();
          diagnostic("timeout", index);
        }
        timer = setTimeout(timeout, timeoutMs);
        try {
          await send(event, signal);
        } catch {
          diagnostic("failed", index);
        } finally {
          clearTimeout(timer);
          sending = false;
        }
      }
      active = undefined;
    }
    function enqueue(event: ReviewEvent): void {
      if (disabled) return;
      if (queue.length + (sending ? 1 : 0) >= capacity) {
        if (!overflowReported) diagnostic("overflow", index);
        overflowReported = true;
        return;
      }
      queue.push(event);
      if (!active) {
        // Schedule rather than invoking provider code on the domain call stack.
        active = run();
      }
    }
    function stop(): void {
      clearTimeout(timer);
      disabled = true;
      queue.length = 0;
      controller?.abort();
    }
    return { role, enqueue, stop, pending: () => active };
  });
  let closed = false;
  function observe(entry: Record<string, unknown>): void {
    if (closed) return;
    const event = project(entry);
    if (!event) return;
    const error = event.msg === "reviewer_result_accepted_failure" || event.msg === "reviewer_result_wake_failed";
    const actionable = error || event.msg === "reviewer_result_unrouted";
    for (const worker of workers) {
      if (worker.role === "telemetry" || (worker.role === "errors" && error) || (worker.role === "notifications" && actionable)) worker.enqueue(event);
    }
  }
  let draining: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    draining ??= drain();
    return draining;
  }
  async function drain(): Promise<void> {
    closed = true;
    // Let scheduled workers acquire their actual promises before taking the drain snapshot.
    await Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    function deadline(resolve: () => void): void {
      timer = setTimeout(function expired() {
        for (const [index, worker] of workers.entries()) {
          if (worker.pending()) diagnostic("shutdown_deadline", index);
          worker.stop();
        }
        resolve();
      }, drainMs);
    }
    try {
      await Promise.race([Promise.all(workers.map((worker) => worker.pending())), new Promise<void>(deadline)]);
    } finally {
      clearTimeout(timer);
      for (const worker of workers) worker.stop();
    }
  }
  function external(record: LogRecord): void {
    if (record.category.join(".") === "corbits.hub") observe(record.properties);
  }
  const sink: Sink & AsyncDisposable = Object.assign(external, { [Symbol.asyncDispose]: shutdown });
  return { observe, sink, shutdown };
}

const logger = getLogger(["corbits", "hub"]);

/** Existing structured call sites keep their fields and level; only allowlisted events leave the hub. */
export function logJson(entry: Record<string, unknown>): void {
  const level = entry["level"];
  if (level === "error") logger.error("{msg}", entry);
  else if (level === "warn" || level === "warning") logger.warn("{msg}", entry);
  else if (level === "debug") logger.debug("{msg}", entry);
  else logger.info("{msg}", entry);
}

/** Called once per hub entry point, never by createInterchangeHub or sidecars. */
export async function configureObservability(destinations: Destinations, options: { development: boolean }): Promise<{ shutdown: () => Promise<void> }> {
  const { development } = LoggingOptions.assert(options);
  const observability = createObservability(destinations);
  const stockConsole = getConsoleSink({ formatter: development ? ansiColorFormatter : getJsonLinesFormatter() });
  function consoleSink(record: LogRecord): void {
    if (record.category.join(".") === "corbits.hub") {
      console.log(JSON.stringify({ ts: new Date(record.timestamp).toISOString(), ...record.properties }));
    } else stockConsole(record);
  }
  await configure({
    reset: true,
    sinks: { console: consoleSink, external: observability.sink },
    loggers: [
      { category: [], lowestLevel: development ? "debug" : "info", sinks: ["console", "external"] },
      { category: ["corbits", "hub"], lowestLevel: "debug", sinks: ["console", "external"], parentSinks: "override" },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    ],
  });
  return { shutdown: reset };
}
