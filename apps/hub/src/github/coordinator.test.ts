import { expect, test } from "bun:test";
import { createCoordinator, WorkerCapacityError, type TriageJob } from "./coordinator.js";

const START = new Date("2026-10-14T12:00:00Z").getTime();

type Timer = { at: number; fire: () => Promise<void> };

function fakeClock() {
  let now = START;
  const timers = new Set<Timer>();
  function setTimer(fire: () => Promise<void>, ms: number) {
    const timer = { at: now + ms, fire };
    timers.add(timer);
    return function cancel() {
      timers.delete(timer);
    };
  }
  async function advance(ms: number) {
    const until = now + ms;
    for (;;) {
      const [next] = [...timers].filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at);
      if (!next) break;
      timers.delete(next);
      now = next.at;
      await next.fire();
    }
    now = until;
  }
  return { now: () => new Date(now), setTimer, advance };
}

function fakeSpawner() {
  const spawned: TriageJob[] = [];
  const released: string[] = [];
  const ends = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
  return {
    spawned,
    released,
    async end(runId: string) {
      ends.get(runId)!.resolve();
      await Bun.sleep(0);
    },
    async lose(runId: string) {
      ends.get(runId)!.reject(new Error("run row gone"));
      await Bun.sleep(0);
    },
    spawner: {
      async spawn(job: TriageJob) {
        spawned.push(job);
        return `run_${spawned.length}`;
      },
      ended(_tenantId: string, runId: string) {
        return new Promise<void>(function untilEnded(resolve, reject) {
          ends.set(runId, { resolve, reject });
        });
      },
      async release(_tenantId: string, runId: string) {
        released.push(runId);
      },
    },
  };
}

function job(tenantId: string, number: number, payload = {}): TriageJob {
  return { tenantId, workflow: "pr-triage-github", repo: "acme/widgets", number, headSha: "sha1", source: "event", payload };
}

async function noFailure(): Promise<void> {}

const NO_LIMITS = { global: 10, perTenant: 10, spawnsPerSecond: Infinity };

function setup(limits = { global: 2, perTenant: 1, spawnsPerSecond: Infinity }, failed: (j: TriageJob, error: string) => Promise<void> = noFailure) {
  const clock = fakeClock();
  const fake = fakeSpawner();
  const failures: string[] = [];
  const coordinator = createCoordinator({
    spawner: fake.spawner,
    limits,
    retry: { minMs: 1_000, maxMs: 3_000 },
    async failed(j, error) {
      failures.push(`${j.number}:${error}`);
      await failed(j, error);
    },
    setTimer: clock.setTimer,
    now: clock.now,
    log() {},
  });
  return { clock, fake, failed: failures, coordinator };
}

test("a queued pull request is replaced by its newer job, and limits hold per tenant and globally", async () => {
  const { clock, fake, coordinator } = setup();
  coordinator.enqueue(job("t1", 1));
  coordinator.enqueue(job("t1", 2, { head: "old" }));
  coordinator.enqueue(job("t1", 2, { head: "new" }));
  coordinator.enqueue(job("t2", 7));
  coordinator.enqueue(job("t3", 9));
  await clock.advance(0);
  expect(fake.spawned.map((j) => `${j.tenantId}#${j.number}`)).toEqual(["t1#1", "t2#7"]);

  await fake.end("run_1");
  expect(fake.released).toEqual(["run_1"]);
  // t3 has never spawned, so it goes before t1's second pull request.
  expect(fake.spawned.at(-1)!.tenantId).toBe("t3");

  await fake.end("run_2");
  await fake.end("run_3");
  expect(fake.spawned.at(-1)).toMatchObject({ tenantId: "t1", number: 2, payload: { head: "new" } });
  expect(fake.spawned).toHaveLength(4);
});

test("spawns are spaced by the rate limit", async () => {
  const { clock, fake, coordinator } = setup({ global: 10, perTenant: 10, spawnsPerSecond: 2 });
  for (let n = 1; n <= 3; n++) coordinator.enqueue(job("t1", n));
  await clock.advance(0);
  expect(fake.spawned).toHaveLength(1);
  await clock.advance(499);
  expect(fake.spawned).toHaveLength(1);
  await clock.advance(1);
  expect(fake.spawned).toHaveLength(2);
  await clock.advance(500);
  expect(fake.spawned).toHaveLength(3);
});

test("a failed spawn fails the head and frees its slot", async () => {
  const { clock, fake, failed, coordinator } = setup({ global: 1, perTenant: 1, spawnsPerSecond: Infinity });
  const spawn = fake.spawner.spawn;
  fake.spawner.spawn = async function noSeed(): Promise<string> {
    throw new Error("no seed");
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  await Bun.sleep(0);
  expect(failed).toEqual(["1:spawn failed: Error: no seed"]);
  fake.spawner.spawn = spawn;
  coordinator.enqueue(job("t1", 2));
  await clock.advance(0);
  expect(fake.spawned.map((j) => j.number)).toEqual([2]);
});

test("a job for a pull request whose worker is running waits for it, then spawns", async () => {
  const { clock, fake, coordinator } = setup(NO_LIMITS);
  coordinator.enqueue(job("t1", 1, { head: "old" }));
  await clock.advance(0);
  coordinator.enqueue(job("t1", 1, { head: "new" }));
  coordinator.enqueue(job("t1", 2));
  await clock.advance(0);
  expect(fake.spawned.map((j) => j.number)).toEqual([1, 2]);
  await fake.end("run_1");
  expect(fake.spawned.map((j) => j.number)).toEqual([1, 2, 1]);
  expect(fake.spawned.at(-1)).toMatchObject({ number: 1, payload: { head: "new" } });
});

test("a worker whose end could not be observed is still released, and its slot freed", async () => {
  const { clock, fake, coordinator } = setup({ global: 1, perTenant: 1, spawnsPerSecond: Infinity });
  coordinator.enqueue(job("t1", 1));
  coordinator.enqueue(job("t1", 2));
  await clock.advance(0);
  await fake.lose("run_1");
  expect(fake.released).toEqual(["run_1"]);
  expect(fake.spawned.map((j) => j.number)).toEqual([1, 2]);
});

test("a head that could not be failed does not stall the queue", async () => {
  async function stateConflict(): Promise<void> {
    throw new Error("state conflict");
  }
  const { clock, fake, failed, coordinator } = setup({ global: 1, perTenant: 1, spawnsPerSecond: Infinity }, stateConflict);
  const spawn = fake.spawner.spawn;
  fake.spawner.spawn = async function noSeedForFirst(j: TriageJob): Promise<string> {
    if (j.number === 1) throw new Error("no seed");
    return spawn(j);
  };
  coordinator.enqueue(job("t1", 1));
  coordinator.enqueue(job("t1", 2));
  await clock.advance(0);
  await Bun.sleep(0);
  expect(failed).toEqual(["1:spawn failed: Error: no seed"]);
  expect(fake.spawned.map((j) => j.number)).toEqual([2]);
});

test("a spawn refused for capacity is retried with backoff, not failed", async () => {
  const { clock, fake, failed, coordinator } = setup(NO_LIMITS);
  const spawn = fake.spawner.spawn;
  let refusals = 0;
  fake.spawner.spawn = async function refuseThrice(j: TriageJob): Promise<string> {
    if (refusals < 3) {
      refusals += 1;
      throw new WorkerCapacityError("no sidecar slots");
    }
    return spawn(j);
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  expect(fake.spawned).toHaveLength(0);
  await clock.advance(1_000);
  await clock.advance(2_000);
  expect(refusals).toBe(3);
  expect(fake.spawned).toHaveLength(0);
  // The fourth try waits the capped 3 s, not 4 s.
  await clock.advance(3_000);
  expect(fake.spawned.map((j) => j.number)).toEqual([1]);
  expect(failed).toEqual([]);
});

test("a job from another source for a running pull request waits for its worker, and the queue says so", async () => {
  const { clock, fake, coordinator } = setup(NO_LIMITS);
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  coordinator.enqueue({ ...job("t1", 1, { head: "retry" }), source: "retry" });
  coordinator.enqueue({ ...job("t1", 1, { head: "reconcile" }), source: "reconcile" });
  await clock.advance(0);
  expect(fake.spawned.map((j) => j.source)).toEqual(["event"]);
  expect(coordinator.snapshot("t1")).toMatchObject({
    queued: [{ number: 1, source: "reconcile", queuedAt: clock.now().toISOString() }],
    running: [{ number: 1, source: "event", runId: "run_1" }],
  });
  expect(coordinator.snapshot("t2")).toEqual({ queued: [], running: [] });
  await fake.end("run_1");
  expect(fake.spawned.at(-1)).toMatchObject({ source: "reconcile", payload: { head: "reconcile" } });
  expect(fake.spawned).toHaveLength(2);
});
