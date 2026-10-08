import { describe, expect, test } from "bun:test";
import { createReconcileLoop } from "./reconcile-loop.js";

describe("reconcile loop", () => {
  test("retries soon with backoff while a pass cannot deliver, then settles back to the interval", async () => {
    const outcomes = [true, true, false];
    const scheduled: number[] = [];
    let passes = 0;
    const loop = createReconcileLoop(
      async function reconcile() {
        passes += 1;
        return { retry: outcomes.shift() ?? false };
      },
      { intervalMs: 300_000, retryMs: 15_000, retryMaxMs: 120_000, schedule: (run, ms) => { scheduled.push(ms); queueMicrotask(run); } },
      () => {},
    );
    loop.kick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(passes).toBe(3);
    expect(scheduled).toEqual([15_000, 30_000]);
  });
});
