import { expect, test } from "bun:test";
import type { CheckRun } from "@corbits/github-reads";
import { emptyPack, repoPolicy, triageEventOf, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import { createCoalescer, type CoalescedEvent, type CoalescerDeps } from "./coalescer.js";
import { GithubRateLimited } from "./github-usage.js";
import { createPrWorkflowRouter } from "./pr-workflow.js";
import { DEFAULT_RECONCILE_POLICY, planTenant } from "./reconcile-plan.js";
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
  return { store, rows: () => current, saves: () => version };
}

const PULL_REQUEST: Record<string, [string, string]> = {
  opened: ["pull_request", "opened"],
  updated: ["pull_request", "synchronize"],
  ready: ["pull_request", "ready_for_review"],
  checks: ["check_run", "completed"],
  commented: ["issue_comment", "created"],
  approved: ["pull_request_review", "submitted"],
  "changes-requested": ["pull_request_review", "submitted"],
  reviewed: ["pull_request_review", "submitted"],
};

const REVIEW_STATE: Record<string, string> = { approved: "approved", "changes-requested": "changes_requested", reviewed: "commented" };

function delivery(event: TriageEvent, headSha: string): CoalescedEvent {
  const [name, action] = PULL_REQUEST[event]!;
  const mail: PrMail = {
    kind: "pr", repo: REPO, prNumber: 8, deliveryId: crypto.randomUUID(), event: name, action, headSha,
    author: null, title: null, body: null, draft: null, review: null,
  };
  const state = REVIEW_STATE[event];
  if (state) mail.review = { state };
  const derived = triageEventOf(mail);
  if (derived !== event) throw new Error(`delivery ${event} reads as ${derived}`);
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
    async openHeadFor() {
      return async function openHead() {
        return { headSha: "sha1", draft: false };
      };
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

test("a single review is mailed after the burst, not the quiet period", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("approved", "sha1"));
  await clock.advance(WINDOW.burstMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["approved"] })]);
});

test("a review joining an open checks window closes it on the burst with both events", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("checks", "sha1"));
  await clock.advance(10_000);
  await coalescer.accept(delivery("approved", "sha1"));
  await clock.advance(WINDOW.burstMs - 1);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["checks", "approved"] })]);
});

test("comments 10 s apart fold into one run after the quiet period", async () => {
  const { clock, mails, coalescer } = harness();
  for (let i = 0; i < 3; i++) {
    await coalescer.accept(delivery("commented", "sha1"));
    await clock.advance(10_000);
  }
  await clock.advance(WINDOW.quietMs - 10_001);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["commented"] })]);
});

test("commented-only reviews 10 s apart fold into one run after the quiet period", async () => {
  const { clock, mails, coalescer } = harness();
  for (let i = 0; i < 3; i++) {
    await coalescer.accept(delivery("reviewed", "sha1"));
    await clock.advance(10_000);
  }
  await clock.advance(WINDOW.quietMs - 10_001);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["reviewed"] })]);
});

function countedReads(pull: { headSha: string; draft: boolean }) {
  const reads = { pulls: 0, checks: 0 };
  const overrides: Partial<CoalescerDeps> = {
    async headChecks() {
      reads.checks += 1;
      return [{ name: "build", status: "completed", conclusion: "success" }];
    },
    async openHeadFor() {
      return async function openHead() {
        reads.pulls += 1;
        return pull;
      };
    },
  };
  return { reads, overrides };
}

test("a burst of check events gives one mail once none arrived for the quiet period, reading the pull request and its checks once", async () => {
  const { reads, overrides } = countedReads({ headSha: "sha1", draft: false });
  const { clock, mails, coalescer } = harness([], overrides);
  const accepted = [];
  for (let i = 0; i < 5; i++) {
    accepted.push(await coalescer.accept({ ...delivery("checks", "sha1"), draftUnread: true }));
    await clock.advance(5_000);
  }
  expect(accepted).toEqual(["queued", "coalesced", "coalesced", "coalesced", "coalesced"]);
  await clock.advance(WINDOW.quietMs - 5_001);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", event: "check_run", events: ["checks"] })]);
  expect(reads).toEqual({ pulls: 1, checks: 1 });
});

for (const [why, pull] of [["a draft", { headSha: "sha1", draft: true }], ["a moved head", { headSha: "sha2", draft: false }]] as const) {
  test(`a burst of check events on ${why} is dropped at its flush, reading the pull request once and its checks never`, async () => {
    const { reads, overrides } = countedReads(pull);
    const { clock, state, mails, coalescer } = harness([], overrides);
    for (let i = 0; i < 5; i++) await coalescer.accept({ ...delivery("checks", "sha1"), draftUnread: true });
    await clock.advance(WINDOW.quietMs);
    expect(mails).toHaveLength(0);
    expect(state.rows()).toEqual([]);
    expect(reads).toEqual({ pulls: 1, checks: 0 });
  });
}

for (const [why, error, status] of [["fails", new Error("socket hang up"), "failed"], ["hits the GitHub limit", new GithubRateLimited("1", START), "triaged"]] as const) {
  test(`a check window whose pull request read ${why} leaves its head ${status}`, async () => {
    const triaged: PrTriageRow = { number: 8, headSha: "sha1", status: "triaged", attempts: 0, firstSeenAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString() };
    const { clock, state, mails, coalescer } = harness([triaged], {
      async openHeadFor() {
        throw error;
      },
    });
    await coalescer.accept({ ...delivery("checks", "sha1"), draftUnread: true });
    await clock.advance(WINDOW.quietMs);
    expect(mails).toHaveLength(0);
    expect(state.rows()).toEqual([expect.objectContaining({ headSha: "sha1", status })]);
  });
}

for (const start of ["opened", "updated"] as const) {
  test(`a ${start} pull request is triaged after the burst, and a review after its run becomes one follow-up`, async () => {
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
    await clock.advance(WINDOW.burstMs);
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
  await coalescer.accept(delivery("checks", "sha1"));
  await clock.advance(10_000);
  await coalescer.accept(delivery("updated", "sha2"));
  await clock.advance(WINDOW.burstMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha2", events: ["checks", "updated"] })]);
});

test("each event restarts the quiet period, but the window still closes at the maximum wait", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("checks", "sha1"));
  for (let i = 0; i < 5; i++) {
    await clock.advance(20_000);
    await coalescer.accept(delivery("checks", "sha1"));
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

test("a paused-label head whose pull request cannot be read is left failed, and the reconciler queues it again", async () => {
  const route = createPrWorkflowRouter({
    credentials: async () => [],
    live: async () => true,
    readHead: async () => Promise.reject(new Error("502 Bad Gateway")),
    readPull: async () => Promise.reject(new Error("502 Bad Gateway")),
    log() {},
  });
  const { clock, state, mails, coalescer } = harness([], {
    async sendMail(job) {
      if (await route(job)) mails.push(job.payload as Record<string, unknown>);
    },
  });
  await coalescer.accept({ ...delivery("opened", "sha1"), pauseLabel: "hold" });
  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([]);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "failed", error: "delivery failed: Error: 502 Bad Gateway" })]);
  const pr = { number: 8, headSha: "sha1", updatedAt: new Date(START).toISOString(), draft: false };
  const plan = planTenant({ repos: [{ name: REPO, prs: [pr], rows: state.rows() }], runs: new Map(), now: new Date(START + DEFAULT_RECONCILE_POLICY.backoffMaxMs), policy: DEFAULT_RECONCILE_POLICY, workflowVersion: undefined });
  expect(plan.get(REPO)?.enqueue.map((entry) => entry.number)).toEqual([8]);
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

test("a cancelled check releases a head held for CI, so it is mailed for its verdict", async () => {
  let checks: CheckRun[] = [{ name: "build", status: "in_progress", conclusion: null }];
  const { clock, state, mails, coalescer } = harness([], { headChecks: async () => checks });
  const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  await coalescer.accept({ ...delivery("opened", "sha1"), pack });
  await clock.advance(WINDOW.burstMs);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "waiting" })]);

  checks = [{ name: "build", status: "completed", conclusion: "cancelled" }];
  await coalescer.accept({ ...delivery("checks", "sha1"), pack });
  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", events: ["opened", "checks"] })]);
});

test("a head with no checks yet is mailed to be marked waiting as having no CI", async () => {
  const { clock, mails, coalescer } = harness([], { headChecks: async () => [] });
  const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  await coalescer.accept({ ...delivery("updated", "sha2"), pack, automatic: ["labels" as const] });
  await clock.advance(WINDOW.burstMs);
  expect(mails).toEqual([expect.objectContaining({ kind: "waiting", headSha: "sha2", noCi: true })]);
});

function suiteCompleted(headSha: string): CoalescedEvent {
  const input = delivery("checks", headSha);
  return { ...input, mail: { ...input.mail, event: "check_suite" } };
}

function heldForCi() {
  const running = Array.from({ length: 60 }, (_, index): CheckRun => ({ name: `job ${index}`, status: "in_progress", conclusion: null }));
  const ci = { checks: running, reads: 0 };
  const held = harness([], {
    async headChecks() {
      ci.reads += 1;
      return ci.checks;
    },
  });
  const pack = { ...emptyPack(REPO), checks: { "ci-green": { enabled: true } } };
  return { ...held, ci, pack };
}

test("a completed check suite on a head held for CI mails it after the burst once CI finished", async () => {
  const { clock, state, mails, coalescer, ci, pack } = heldForCi();
  await coalescer.accept({ ...delivery("opened", "sha1"), pack });
  await clock.advance(WINDOW.burstMs);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "waiting" })]);

  ci.checks = ci.checks.map((check) => ({ ...check, status: "completed", conclusion: "success" }));
  await coalescer.accept({ ...suiteCompleted("sha1"), pack });
  await clock.advance(WINDOW.burstMs - 1);
  expect(mails).toHaveLength(0);
  await clock.advance(1);
  expect(mails).toEqual([expect.objectContaining({ headSha: "sha1", event: "check_suite", events: ["opened", "checks"] })]);
});

test("check runs finishing on a head held for CI fold on the quiet period and write nothing while CI still runs", async () => {
  const { clock, state, mails, coalescer, ci, pack } = heldForCi();
  await coalescer.accept({ ...delivery("opened", "sha1"), pack });
  await clock.advance(WINDOW.burstMs);
  const before = { reads: ci.reads, saves: state.saves() };

  for (let index = 0; index < 59; index++) {
    ci.checks[index] = { ...ci.checks[index]!, status: "completed", conclusion: "success" };
    await coalescer.accept({ ...delivery("checks", "sha1"), pack });
    await clock.advance(5_000);
  }
  await clock.advance(WINDOW.quietMs);
  expect(mails).toHaveLength(0);
  expect(state.rows()).toEqual([expect.objectContaining({ status: "waiting", events: ["opened"] })]);
  expect({ reads: ci.reads - before.reads, saves: state.saves() - before.saves }).toEqual({ reads: 3, saves: 0 });
});

test("a new commit on a head held for CI carries the events it held, whether or not a window is open", async () => {
  for (const between of [[], ["approved"]] as TriageEvent[][]) {
    const { clock, state, mails, coalescer, ci, pack } = heldForCi();
    await coalescer.accept({ ...delivery("opened", "sha1"), pack });
    await clock.advance(WINDOW.burstMs);
    for (const event of between) await coalescer.accept({ ...delivery(event, "sha1"), pack });

    ci.checks = [{ name: "build", status: "completed", conclusion: "success" }];
    await coalescer.accept({ ...delivery("updated", "sha2"), pack });
    await clock.advance(WINDOW.burstMs);
    expect(mails).toEqual([expect.objectContaining({ headSha: "sha2", events: ["opened", ...between, "updated"] })]);
    expect(state.rows().filter((row) => row.status === "waiting")).toEqual([]);
  }
});
