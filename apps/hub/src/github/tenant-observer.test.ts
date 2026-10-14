import { expect, test } from "bun:test";
import { createRecordPass, createTenantObserver, createTenantVersions } from "./tenant-observer.js";
import type { ObservedRuns } from "./triage-runs.js";

const LIVE = { runId: "run_live", address: "run_live@t.test", createdAt: new Date(0), cancelling: false };

test("one read of a tenant's logs at a time, shared by every caller, and reused until the interval after it finished", async () => {
  let now = 0;
  let reads = 0;
  let inFlight = 0;
  let mostInFlight = 0;
  let release: () => void = () => {};
  async function observeRuns(): Promise<ObservedRuns> {
    reads += 1;
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    inFlight -= 1;
    return { byRepo: new Map(), runCount: 0, verdicts: [], approved: [] };
  }
  const observer = createTenantObserver({
    liveDeployments: async () => [LIVE],
    observeRuns,
    recordRuns: async () => true,
    versions: createTenantVersions(),
    minIntervalMs: 2_000,
    now: () => new Date(now),
  });

  const reconciler = observer.observe("t", "t.test");
  const loop = observer.observe("t", "t.test");
  await Promise.resolve();
  await Promise.resolve();
  release();
  expect(await reconciler).toBe(await loop);
  now = 1_999;
  await observer.observe("t", "t.test");
  expect(reads).toBe(1);

  now = 2_000;
  const fresh = observer.observe("t", "t.test");
  await Promise.resolve();
  await Promise.resolve();
  release();
  await fresh;
  expect(reads).toBe(2);
  expect(mostInFlight).toBe(1);
});

test("a tenant whose logs cannot be read is retried with backoff, logged once per step, and stays unread until a read succeeds", async () => {
  let now = 0;
  const reads: string[] = [];
  const logged: unknown[] = [];
  const bad = { id: "bad", domain: "bad.test" };
  const good = { id: "good", domain: "good.test" };
  const recording = createRecordPass({
    observer: {
      async observe(tenantId) {
        reads.push(tenantId);
        if (tenantId === "bad") throw new Error("unreadable");
        return { deployments: [], observed: [] };
      },
    },
    activeTenants: async (what) => (what === "deployments" ? [bad, good] : []),
    endedWithinMs: 4_000,
    backoffMs: 2_000,
    maxBackoffMs: 8_000,
    now: () => new Date(now),
    log: (entry) => logged.push(entry["retryInMs"]),
  });
  expect(recording.ready("good")).toBe(false);
  for (; now <= 20_000; now += 2_000) await recording.pass();
  expect(recording.ready("good")).toBe(true);
  expect(recording.ready("bad")).toBe(false);
  // Read at 0, 2, 6 and 14 seconds: each failure doubles the wait, up to 8.
  expect(reads.filter((tenant) => tenant === "bad")).toHaveLength(4);
  expect(logged).toEqual([2_000, 4_000, 8_000, 8_000]);
});

test("the version moves when a verdict's detail changes, and again after a read whose recording failed", async () => {
  let feedback = "Please rebase.";
  let records = true;
  const versions = createTenantVersions();
  const observer = createTenantObserver({
    liveDeployments: async () => [LIVE],
    async observeRuns(): Promise<ObservedRuns> {
      const verdict = {
        runId: "run_1", repo: "acme/widgets", number: 1, headSha: "sha1", startedAt: new Date(0), verdictAt: new Date(0), settled: true,
        state: "needs-author-update", actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: false, detail: { feedback },
      };
      return { byRepo: new Map(), runCount: 1, verdicts: [verdict], approved: [] };
    },
    recordRuns: async () => records,
    versions,
    minIntervalMs: 0,
    now: () => new Date(0),
  });
  await observer.observe("t", "t.test");
  await observer.observe("t", "t.test");
  expect(versions.get("t")).toBe(1);
  feedback = "Please rebase onto main.";
  records = false;
  await observer.observe("t", "t.test");
  expect(versions.get("t")).toBe(2);
  records = true;
  await observer.observe("t", "t.test");
  expect(versions.get("t")).toBe(3);
});

test("a tenant whose child run ended since the last pass is read, as one with a run in flight is, so a run inserted already completed is recorded promptly", async () => {
  let now = 10_000;
  const reads: string[] = [];
  const ended = { id: "bb", domain: "bb.test" };
  const recording = createRecordPass({
    observer: {
      async observe(tenantId) {
        reads.push(tenantId);
        return { deployments: [], observed: [] };
      },
    },
    activeTenants: async (what, endedSince) => (what === "runs" && endedSince !== undefined && endedSince.getTime() <= 8_000 ? [ended] : []),
    endedWithinMs: 4_000,
    backoffMs: 2_000,
    maxBackoffMs: 8_000,
    now: () => new Date(now),
    log: () => {},
  });
  await recording.pass();
  expect(reads).toEqual(["bb"]);
  now = 14_000;
  await recording.pass();
  expect(reads).toEqual(["bb"]);
});
