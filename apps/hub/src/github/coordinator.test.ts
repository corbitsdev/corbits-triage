import { expect, test } from "bun:test";
import { createCoordinator, OUTDATED_REASON, WorkerDeferredError, WorkerOutdatedError, type TriageJob } from "./coordinator.js";

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

function setup(failed: (j: TriageJob, error: string) => Promise<void> = noFailure) {
  const clock = fakeClock();
  const fake = fakeSpawner();
  const failures: string[] = [];
  const coordinator = createCoordinator({
    spawner: fake.spawner,
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

test("a failed spawn fails the head", async () => {
  const { clock, fake, failed, coordinator } = setup();
  fake.spawner.spawn = async function noSeed(): Promise<string> {
    throw new Error("no seed");
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  await Bun.sleep(0);
  expect(failed).toEqual(["1:spawn failed: Error: no seed"]);
});

test("a job for a pull request whose worker is running waits for it, then spawns", async () => {
  const { clock, fake, coordinator } = setup();
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

test("a worker whose end could not be observed is still released", async () => {
  const { clock, fake, coordinator } = setup();
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  await fake.lose("run_1");
  expect(fake.released).toEqual(["run_1"]);
});

test("a head that could not be failed does not stall the queue", async () => {
  async function stateConflict(): Promise<void> {
    throw new Error("state conflict");
  }
  const { clock, fake, failed, coordinator } = setup(stateConflict);
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
  const { clock, fake, failed, coordinator } = setup();
  const spawn = fake.spawner.spawn;
  let refusals = 0;
  fake.spawner.spawn = async function refuseThrice(j: TriageJob): Promise<string> {
    if (refusals < 3) {
      refusals += 1;
      throw new WorkerDeferredError("no sidecar slots");
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

test("a worker the sender gate keeps refusing is retried five times, then its head fails and no further worker is provisioned", async () => {
  const { clock, fake, failed, coordinator } = setup();
  let refusals = 0;
  fake.spawner.spawn = async function outdated(): Promise<string> {
    refusals += 1;
    throw new WorkerOutdatedError("Workflow run does not admit mail from this sender");
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  for (let retry = 0; retry < 10; retry += 1) await clock.advance(3_000);
  await Bun.sleep(0);
  expect(refusals).toBe(6);
  expect(failed).toEqual([`1:${OUTDATED_REASON}`]);
});

test("a job from another source for a running pull request waits for its worker", async () => {
  const { clock, fake, coordinator } = setup();
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  coordinator.enqueue({ ...job("t1", 1, { head: "retry" }), source: "retry" });
  coordinator.enqueue({ ...job("t1", 1, { head: "reconcile" }), source: "reconcile" });
  await clock.advance(0);
  expect(fake.spawned.map((j) => j.source)).toEqual(["event"]);
  await fake.end("run_1");
  expect(fake.spawned.at(-1)).toMatchObject({ source: "reconcile", payload: { head: "reconcile" } });
  expect(fake.spawned).toHaveLength(2);
});

test("a pull request's code review is a job of its own beside its triage", async () => {
  const { clock, fake, coordinator } = setup();
  coordinator.enqueue(job("t1", 1));
  coordinator.enqueue({ ...job("t1", 1), workflow: "pr-code-review-github" });
  await clock.advance(0);
  expect(fake.spawned.map((j) => j.workflow)).toEqual(["pr-triage-github", "pr-code-review-github"]);
});

test("a newer head's job replaces a queued one whatever workflow of the lane each names, so one pull request gets one run", async () => {
  const { clock, fake, coordinator } = setup();
  const spawn = fake.spawner.spawn;
  fake.spawner.spawn = async function refuseFirst(j: TriageJob): Promise<string> {
    if (j.headSha === "sha1") throw new WorkerDeferredError("no sidecar slots");
    return spawn(j);
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  coordinator.enqueue({ ...job("t1", 1), workflow: "pr-workflow-anthropic-github", headSha: "sha2" });
  await clock.advance(3_000);
  expect(fake.spawned.map((j) => [j.workflow, j.headSha])).toEqual([["pr-workflow-anthropic-github", "sha2"]]);
});

test("a deferred job whose head a newer job replaced while it spawned is dropped, never run later", async () => {
  const { clock, fake, failed, coordinator } = setup();
  const spawn = fake.spawner.spawn;
  let refuse: (() => void) | undefined;
  fake.spawner.spawn = async function deferFirstLater(j: TriageJob): Promise<string> {
    if (j.headSha !== "sha1") return spawn(j);
    await new Promise<void>(function untilRefused(resolve) {
      refuse = resolve;
    });
    throw new WorkerDeferredError("no sidecar slots");
  };
  coordinator.enqueue(job("t1", 1));
  await clock.advance(0);
  coordinator.enqueue({ ...job("t1", 1), workflow: "pr-workflow-anthropic-github", headSha: "sha2" });
  refuse!();
  await Bun.sleep(0);
  await clock.advance(10_000);
  await fake.end("run_1");
  await clock.advance(10_000);
  expect(fake.spawned.map((j) => j.headSha)).toEqual(["sha2"]);
  expect(failed).toEqual([]);
});
