import { expect, test } from "bun:test";
import type { CheckRun } from "@corbits/github-reads";
import { emptyPack, repoPolicy, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import { createCoalescer, type CoalescedEvent, type CoalescerDeps } from "./coalescer.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";
import type { PrMail } from "./normalize.js";
import type { TriageStateStore } from "./triage-state-store.js";

const TENANT_ID = "tnt_1";
const REPO = "acme/widgets";
const START = new Date("2026-10-09T12:00:00Z").getTime();
const WINDOW = { quietMs: 30_000, maxWaitMs: 120_000, burstMs: 3_000 };

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
  return { now: () => new Date(now), setTimer, advance, pending: () => timers.size };
}

function memoryStore(rows: PrTriageRow[] = []) {
  let current = rows;
  let version = 0;
  const store: TriageStateStore = {
    async load() {
      return { rows: current, version: { artifactId: "art_state", version } };
    },
    async save(_tenant, _repo, next) {
      current = next;
      version += 1;
      return { artifactId: "art_state", version };
    },
  };
  return { store, rows: () => current };
}

const PULL_REQUEST: Record<string, [string, string]> = {
  opened: ["pull_request", "opened"],
  updated: ["pull_request", "synchronize"],
  ready: ["pull_request", "ready_for_review"],
  checks: ["check_run", "completed"],
  commented: ["issue_comment", "created"],
  approved: ["pull_request_review", "submitted"],
};

function delivery(event: TriageEvent, headSha: string): CoalescedEvent {
  const [name, action] = PULL_REQUEST[event]!;
  const mail: PrMail = {
    kind: "pr", repo: REPO, prNumber: 8, deliveryId: crypto.randomUUID(), event: name, action, headSha,
    author: null, title: null, body: null, draft: null, review: null,
  };
  return {
    tenantId: TENANT_ID, workflow: "pr-triage", record: { name: REPO, connected: true }, policy: repoPolicy({ enabled: true }),
    pack: emptyPack(REPO), automatic: [], source: { repo: { id: "art_pack", version: 1 } }, mail, number: 8, headSha, event,
  };
}

function withAction(event: TriageEvent, headSha: string, action: string): CoalescedEvent {
  const input = delivery(event, headSha);
  return { ...input, mail: { ...input.mail, action } };
}

function harness(rows: PrTriageRow[] = [], overrides: Partial<CoalescerDeps> = {}) {
  const clock = fakeClock();
  const state = memoryStore(rows);
  const mails: Array<Record<string, unknown>> = [];
  const coalescer = createCoalescer({
    store: state.store,
    async sendMail(job) {
      mails.push(job.payload as Record<string, unknown>);
    },
    async headChecks() {
      return [{ name: "build", status: "completed", conclusion: "success" }];
    },
    window: WINDOW,
    ciWait: DEFAULT_RECONCILE_POLICY,
    setTimer: clock.setTimer,
    now: clock.now,
    log() {},
    ...overrides,
  });
  return { clock, state, mails, coalescer };
}

test("a burst of chatter gives one mail with every event seen once none arrived for the quiet period", async () => {
  const { clock, mails, coalescer } = harness();
  const burst: TriageEvent[] = ["commented", "checks", "approved", "commented", "checks"];
  const accepted = [];
  for (const event of burst) {
    accepted.push(await coalescer.accept(delivery(event, "sha1")));
    await clock.advance(5_000);
  }
  expect(accepted).toEqual(["queued", "coalesced", "coalesced", "coalesced", "coalesced"]);
  await clock.advance(WINDOW.quietMs - 5_001);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", event: "check_run", events: ["commented", "checks", "approved"] })]);
});

for (const start of ["opened", "updated"] as const) {
  test(`a ${start} pull request is triaged after the burst, and chatter during its run becomes one follow-up`, async () => {
    const { clock, mails, coalescer } = harness();
    await coalescer.accept(delivery(start, "sha2"));
    await clock.advance(1_000);
    await coalescer.accept(delivery("commented", "sha2"));
    await clock.advance(1_999);
    await coalescer.accept(delivery("checks", "sha2"));
    expect(mails).toHaveLength(0);
    await clock.advance(1);
    expect(mails).toEqual([expect.objectContaining({ headSha: "sha2", events: [start, "commented", "checks"] })]);

    await coalescer.accept(delivery("checks", "sha2"));
    await clock.advance(5_000);
    await coalescer.accept(delivery("approved", "sha2"));
    await clock.advance(WINDOW.quietMs);
    expect(mails.slice(1)).toEqual([expect.objectContaining({ headSha: "sha2", events: ["checks", "approved"] })]);
  });
}

test("a pull request marked ready before any run also wakes its opening actions; one triaged before does not", async () => {
  const fresh = harness();
  await fresh.coalescer.accept(delivery("ready", "sha1"));
  await fresh.clock.advance(WINDOW.burstMs);
  expect(fresh.mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["ready", "opened"] })]);
  const ran: PrTriageRow = { number: 8, headSha: "sha0", status: "triaged", runId: "run_1", attempts: 0, firstSeenAt: "2026-10-09T11:00:00.000Z", updatedAt: "2026-10-09T11:00:00.000Z" };
  const triaged = harness([ran]);
  await triaged.coalescer.accept(delivery("ready", "sha1"));
  await triaged.clock.advance(WINDOW.burstMs);
  expect(triaged.mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["ready"] })]);
});

test("pushes inside the burst give one mail on the latest head, closing at the first burst", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("opened", "sha1"));
  await clock.advance(1_000);
  await coalescer.accept(delivery("updated", "sha2"));
  await clock.advance(1_500);
  await coalescer.accept(delivery("updated", "sha3"));
  await clock.advance(499);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha3", events: ["opened", "updated"] })]);
  await clock.advance(200_000);
  expect(mails).toHaveLength(1);
});

test("a push during the previous head's run gives exactly one follow-up on the new head", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("updated", "sha1"));
  await clock.advance(3_000);
  await coalescer.accept(delivery("updated", "sha2"));
  await clock.advance(200_000);
  expect(mails.map((mail) => mail.headSha)).toEqual(["sha1", "sha2"]);
});

test("a late pull_request event naming an older head never moves the head back, in its window or after it", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("updated", "sha2"));
  await coalescer.accept(withAction("updated", "sha1", "edited"));
  await clock.advance(WINDOW.burstMs);
  await coalescer.accept(withAction("updated", "sha1", "review_requested"));
  await clock.advance(WINDOW.quietMs);
  expect(mails.map((mail) => mail.headSha)).toEqual(["sha2", "sha2"]);
});

test("a new commit closes a window of chatter on the burst and moves its head", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("commented", "sha1"));
  await clock.advance(10_000);
  await coalescer.accept(delivery("updated", "sha2"));
  await clock.advance(WINDOW.burstMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha2", events: ["commented", "updated"] })]);
});

test("each event restarts the quiet period, but the window still closes at the maximum wait", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("commented", "sha1"));
  for (let i = 0; i < 5; i++) {
    await clock.advance(20_000);
    await coalescer.accept(delivery("commented", "sha1"));
  }
  await clock.advance(WINDOW.maxWaitMs - 5 * 20_000 - 1);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toHaveLength(1);
});

test("a window of only check runs is dropped while a check is pending, and the head's row is put back", async () => {
  const triaged: PrTriageRow = { number: 8, headSha: "sha1", status: "triaged", attempts: 1, runId: "wfr_1", firstSeenAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() };
  const { clock, state, mails, coalescer } = harness([triaged], {
    async headChecks() {
      return [{ name: "build", status: "completed", conclusion: "success" }, { name: "test", status: "in_progress", conclusion: null }];
    },
  });
  expect(await coalescer.accept(delivery("checks", "sha1"))).toBe("queued");
  expect(state.rows()).toEqual([expect.objectContaining({ status: "queued" })]);
  await clock.advance(WINDOW.quietMs);
  expect(mails).toHaveLength(0);
  expect(state.rows()).toEqual([triaged]);
});

test("a mail that fails at flush leaves the row failed for the reconciler", async () => {
  const { clock, state, coalescer } = harness([], {
    async sendMail() {
      throw new Error("no live deployment");
    },
  });
  await coalescer.accept(delivery("opened", "sha1"));
  await clock.advance(WINDOW.quietMs);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "failed", error: "delivery failed: Error: no live deployment" })]);
});

test("a head already queued still gets a window of its own, since its run may have read facts already", async () => {
  const queuedAt = new Date(START - 60_000).toISOString();
  const queued: PrTriageRow = { number: 8, headSha: "sha1", status: "queued", attempts: 1, firstSeenAt: queuedAt, queuedAt, updatedAt: queuedAt };
  const { clock, mails, coalescer } = harness([queued]);
  expect(await coalescer.accept(delivery("commented", "sha1"))).toBe("queued");
  await clock.advance(WINDOW.quietMs);
  expect(mails.map((mail) => mail.events)).toEqual([["commented"]]);
});

test("a check run on a superseded commit joins the window without moving its head", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("updated", "sha2"));
  await coalescer.accept(delivery("checks", "sha1"));
  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha2", events: ["updated", "checks"] })]);
});

test("stopping cancels every open window's timers", async () => {
  const { clock, coalescer } = harness();
  await coalescer.accept(delivery("opened", "sha1"));
  expect(clock.pending()).toBe(2);
  coalescer.stop();
  expect(clock.pending()).toBe(0);
});

test("a policy that reads CI holds the head while CI runs, mails it once on its first failed check with the events it held, and not again while checks still run", async () => {
  const running = { name: "test", status: "in_progress", conclusion: null };
  let checks: CheckRun[] = [{ name: "lint", status: "in_progress", conclusion: null }, running];
  const { clock, state, mails, coalescer } = harness([], { headChecks: async () => checks });
  const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  const event = (name: TriageEvent) => ({ ...delivery(name, "sha1"), pack });

  await coalescer.accept(event("opened"));
  await clock.advance(WINDOW.burstMs);
  expect(mails).toHaveLength(0);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "waiting", events: ["opened"] })]);

  checks = [{ name: "lint", status: "completed", conclusion: "failure" }, running];
  await coalescer.accept(event("checks"));
  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["opened", "checks"] })]);

  await coalescer.accept(event("checks"));
  await clock.advance(WINDOW.quietMs);
  expect(mails).toHaveLength(1);
});

test("a head held for CI where triage writes labels is mailed to be marked waiting once, then mailed for its verdict when CI finishes", async () => {
  let checks: CheckRun[] = [{ name: "build", status: "in_progress", conclusion: null }];
  const { clock, mails, coalescer } = harness([], { headChecks: async () => checks });
  const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  const event = (name: TriageEvent) => ({ ...delivery(name, "sha1"), pack, automatic: ["labels" as const] });

  await coalescer.accept(event("opened"));
  await clock.advance(WINDOW.burstMs);
  await coalescer.accept(event("commented"));
  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([expect.objectContaining({ kind: "waiting", prNumber: 8, headSha: "sha1", automatic: ["labels"] })]);

  checks = [{ name: "build", status: "completed", conclusion: "success" }];
  await coalescer.accept(event("checks"));
  await clock.advance(WINDOW.quietMs);
  expect(mails.map((mail) => mail.kind)).toEqual(["waiting", "pr"]);
});
