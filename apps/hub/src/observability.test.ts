import { expect, spyOn, test } from "bun:test";
import { getLogger } from "@intx/log";
import { configureObservability, createObservability, logJson, type ReviewEvent } from "./observability.js";

const EVENT: ReviewEvent = { msg: "reviewer_result_accepted_failure", tenantId: "tenant", source: "github", repo: "acme/widgets", number: 7, head: "abc", runId: "reviewer", managerRunId: "manager", kind: "code-review" };
const SECRET = "SENTINEL_credentials_prompt_source_exception";

function capture(events: ReviewEvent[]) {
  return async function send(event: ReviewEvent): Promise<void> { events.push(event); };
}

async function tick(): Promise<void> { await Bun.sleep(10); }

test("external projection routes only known events to distinct roles, never raw payloads or templates", async () => {
  const telemetry: ReviewEvent[] = [], errors: ReviewEvent[] = [], notifications: ReviewEvent[] = [];
  const obs = createObservability({ telemetry: [capture(telemetry)], errors: [capture(errors)], notifications: [capture(notifications)] });
  obs.observe({ ...EVENT, error: new Error(SECRET), message: SECRET, result: { summary: SECRET }, token: SECRET, mail: SECRET });
  obs.observe({ ...EVENT, msg: "reviewer_result_duplicate", failed: SECRET });
  obs.observe({ ...EVENT, msg: "reviewer_result_unrouted" });
  obs.observe({ ...EVENT, msg: SECRET });
  obs.observe({ ...EVENT, source: "invalid", error: SECRET });
  await obs.shutdown();
  expect(telemetry.map((event) => event.msg)).toEqual([EVENT.msg, "reviewer_result_duplicate", "reviewer_result_unrouted"]);
  expect(errors).toEqual([EVENT]);
  expect(notifications).toEqual([EVENT, { ...EVENT, msg: "reviewer_result_unrouted" }]);
  expect(JSON.stringify({ telemetry, errors, notifications })).not.toContain(SECRET);
  obs.observe(EVENT);
  expect(telemetry).toHaveLength(3);
});

test("throwing destinations are isolated, and diagnostics never include provider exceptions", async () => {
  const diagnostics = spyOn(console, "log").mockImplementation(function ignore() {});
  const delivered: ReviewEvent[] = [];
  function throwing(): Promise<void> { throw new Error(SECRET); }
  async function rejecting(): Promise<void> { throw new Error(SECRET); }
  const obs = createObservability({ telemetry: [throwing, rejecting, capture(delivered)], errors: [], notifications: [] });
  try {
    obs.observe(EVENT);
    obs.observe(EVENT);
    await obs.shutdown();
    expect(delivered).toEqual([EVENT, EVENT]);
    expect(diagnostics.mock.calls).toHaveLength(4);
    expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(SECRET);
  } finally { diagnostics.mockRestore(); }
});

test("saturation drops newest, hung sends time out once and never gain another in-flight promise", async () => {
  const diagnostics = spyOn(console, "log").mockImplementation(function ignore() {});
  let calls = 0;
  let signal: AbortSignal | undefined;
  function hung(_event: ReviewEvent, abort: AbortSignal): Promise<void> {
    calls++;
    signal = abort;
    return new Promise<void>(function never() {});
  }
  const delivered: ReviewEvent[] = [];
  const obs = createObservability({ telemetry: [hung, capture(delivered)], errors: [], notifications: [] }, { capacity: 2, timeoutMs: 20, drainMs: 20 });
  try {
    obs.observe(EVENT);
    obs.observe({ ...EVENT, number: 8 });
    obs.observe({ ...EVENT, number: 9 });
    await Bun.sleep(40);
    for (let i = 0; i < 100; i++) obs.observe(EVENT);
    await tick();
    expect(calls).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(delivered.slice(0, 2).map((event) => event.number)).toEqual([7, 8]);
    const started = performance.now();
    await obs.shutdown();
    expect(performance.now() - started).toBeLessThan(500);
    expect(diagnostics.mock.calls.map((call) => String(call[0])).join("\n")).toContain('"reason":"overflow"');
    expect(diagnostics.mock.calls.map((call) => String(call[0])).join("\n")).toContain('"reason":"timeout"');
  } finally { await obs.shutdown(); diagnostics.mockRestore(); }
});

test("shutdown deadline aborts an active destination and discards queued events", async () => {
  let signal: AbortSignal | undefined;
  let calls = 0;
  function hung(_event: ReviewEvent, abort: AbortSignal): Promise<void> {
    calls++;
    signal = abort;
    return new Promise<void>(function never() {});
  }
  const obs = createObservability({ telemetry: [], errors: [], notifications: [hung] }, { timeoutMs: 1000, drainMs: 10 });
  obs.observe(EVENT);
  obs.observe(EVENT);
  await obs.shutdown();
  expect(signal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test("central stock logging preserves local JSON, exports only app projections and disposes asynchronously", async () => {
  const output = spyOn(console, "log").mockImplementation(function ignore() {});
  const events: ReviewEvent[] = [];
  const obs = await configureObservability({ telemetry: [capture(events)], errors: [], notifications: [] }, { development: false });
  try {
    logJson({ ...EVENT, level: "error", error: SECRET });
    getLogger(["hub"]).error(SECRET, { ...EVENT, error: SECRET });
    logJson({ ...EVENT, msg: SECRET });
    await obs.shutdown();
    expect(events).toEqual([EVENT]);
    expect(output.mock.calls.some((call) => String(call[0]).includes('"msg":"reviewer_result_accepted_failure"'))).toBe(true);
    expect(output.mock.calls.some((call) => String(call[0]).includes(SECRET))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  } finally { output.mockRestore(); }
});

for (const development of [true, false]) {
  test(`stock logging preserves ${development ? "development" : "production"} output without changing application JSON`, async () => {
    const debug = spyOn(console, "debug").mockImplementation(function ignore() {});
    const info = spyOn(console, "info").mockImplementation(function ignore() {});
    const output = spyOn(console, "log").mockImplementation(function ignore() {});
    const events: ReviewEvent[] = [];
    const obs = await configureObservability({ telemetry: [capture(events)], errors: [], notifications: [] }, { development });
    try {
      getLogger(["hub"]).debug("stock-debug");
      getLogger(["hub"]).info("stock-info");
      logJson({ ...EVENT, level: "debug" });
      await obs.shutdown();
      expect(debug.mock.calls).toHaveLength(development ? 1 : 0);
      expect(info.mock.calls).toHaveLength(1);
      if (development) {
        expect(String(info.mock.calls[0]?.[0])).toContain("\x1b[");
        expect(String(info.mock.calls[0]?.[0])).toContain("stock-info");
      } else {
        expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ level: "INFO", message: "stock-info" });
      }
      expect(output.mock.calls).toHaveLength(1);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ ...EVENT, level: "debug" });
      expect(events).toEqual([EVENT]);
    } finally {
      await obs.shutdown();
      debug.mockRestore();
      info.mockRestore();
      output.mockRestore();
    }
  });
}

test("destination roles must be explicitly configured", () => {
  // @ts-expect-error Missing configuration is not an instruction to disable delivery.
  expect(() => createObservability()).toThrow(/must be an object/);
  // @ts-expect-error Each role is required even when the other roles are disabled.
  expect(() => createObservability({ errors: [], notifications: [] })).toThrow(/telemetry/);
  // @ts-expect-error Each role is required even when the other roles are disabled.
  expect(() => createObservability({ telemetry: [], notifications: [] })).toThrow(/errors/);
  // @ts-expect-error Each role is required even when the other roles are disabled.
  expect(() => createObservability({ telemetry: [], errors: [] })).toThrow(/notifications/);
});

test("explicit empty destination arrays disable delivery", async () => {
  const diagnostics = spyOn(console, "log").mockImplementation(function ignore() {});
  try {
    const disabled = createObservability({ telemetry: [], errors: [], notifications: [] });
    disabled.observe(EVENT);
    await disabled.shutdown();
    for (const role of ["telemetry", "errors", "notifications"] as const) {
      const events: ReviewEvent[] = [];
      const obs = createObservability({ telemetry: [], errors: [], notifications: [], [role]: [capture(events)] });
      obs.observe(EVENT);
      await obs.shutdown();
      expect(events).toEqual([EVENT]);
    }
    expect(diagnostics.mock.calls).toHaveLength(0);
  } finally { diagnostics.mockRestore(); }
});

test("invalid destinations and missing logging mode fail configuration", async () => {
  // @ts-expect-error Runtime callers must not silently disable invalid providers.
  expect(() => createObservability({ telemetry: [null], errors: [], notifications: [] })).toThrow(/telemetry/);
  // @ts-expect-error Logging mode must be supplied by composition.
  await expect(configureObservability({ telemetry: [], errors: [], notifications: [] })).rejects.toThrow(/must be an object/);
  // @ts-expect-error An omitted boolean is not production mode.
  await expect(configureObservability({ telemetry: [], errors: [], notifications: [] }, {})).rejects.toThrow(/development/);
});
