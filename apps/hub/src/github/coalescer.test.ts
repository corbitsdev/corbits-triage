import { expect, test } from "bun:test";
import { emptyPack, repoPolicy, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import { createCoalescer, type CoalescedEvent, type CoalescerDeps } from "./coalescer.js";
import type { PrMail } from "./normalize.js";
import type { TriageStateStore } from "./triage-state-store.js";

const TENANT_ID = "tnt_1";
const REPO = "acme/widgets";
const START = new Date("2026-10-09T12:00:00Z").getTime();
const WINDOW = { quietMs: 30_000, maxWaitMs: 120_000 };

type Timer = { at: number; fire: () => Promise<void> };

/** Time moves only on `advance`, which fires due timers in order and waits for each. */
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
    pack: emptyPack(REPO), mail, number: 8, headSha, event,
  };
}

function harness(rows: PrTriageRow[] = [], overrides: Partial<CoalescerDeps> = {}) {
  const clock = fakeClock();
  const state = memoryStore(rows);
  const mails: Array<Record<string, unknown>> = [];
  const coalescer = createCoalescer({
    store: state.store,
    async sendMail(_tenant, _workflow, payload) {
      mails.push(payload as Record<string, unknown>);
    },
    async headChecks() {
      return [{ name: "build", status: "completed", conclusion: "success" }];
    },
    window: WINDOW,
    setTimer: clock.setTimer,
    now: clock.now,
    log() {},
    ...overrides,
  });
  return { clock, state, mails, coalescer };
}

test("a burst of six events gives one mail with the latest head and every event seen", async () => {
  const { clock, state, mails, coalescer } = harness();
  const burst: Array<[TriageEvent, string]> = [["opened", "sha1"], ["checks", "sha1"], ["commented", "sha1"], ["updated", "sha2"], ["approved", "sha2"], ["checks", "sha2"]];
  const accepted = [];
  for (const [event, head] of burst) {
    accepted.push(await coalescer.accept(delivery(event, head)));
    await clock.advance(5_000);
  }
  expect(accepted).toEqual(["queued", "coalesced", "coalesced", "coalesced", "coalesced", "coalesced"]);
  expect(mails).toHaveLength(0);
  expect(state.rows().find((row) => row.headSha === "sha2")).toMatchObject({ status: "queued", queuedAt: new Date(START + 15_000).toISOString() });

  await clock.advance(WINDOW.quietMs);
  expect(mails).toEqual([expect.objectContaining({
    repo: REPO, prNumber: 8, headSha: "sha2", event: "check_run", action: "completed",
    events: ["opened", "checks", "commented", "updated", "approved"],
  })]);
});

test("each event restarts the quiet period, but the window still closes at the maximum wait", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("opened", "sha1"));
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
