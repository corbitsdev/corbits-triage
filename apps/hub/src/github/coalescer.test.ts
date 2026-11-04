import { expect, test } from "bun:test";
import { emptyPack, repoPolicy, triageEventOf, type PrTriageRow, type TriageEvent } from "@corbits/triage-contracts";
import { createCoalescer, type CoalescedEvent } from "./coalescer.js";
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
  return { now: () => new Date(now), setTimer, advance };
}

function memoryStore(rows: PrTriageRow[]): TriageStateStore {
  let current = rows;
  let version = 0;
  return {
    async load() {
      return { rows: current, version: { artifactId: "art_state", version } };
    },
    async save(_tenant, _repo, next) {
      current = next;
      version += 1;
      return { artifactId: "art_state", version };
    },
  };
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
    pack: emptyPack(REPO), automatic: [], source: { file: { path: ".corbits-triage.yml", sha: "art_pack-1" } }, mail, number: 8, headSha, event,
  };
}

function withAction(event: TriageEvent, headSha: string, action: string): CoalescedEvent {
  const input = delivery(event, headSha);
  return { ...input, mail: { ...input.mail, action } };
}

function harness(rows: PrTriageRow[] = []) {
  const clock = fakeClock();
  const mails: Array<Record<string, unknown>> = [];
  const coalescer = createCoalescer({
    store: memoryStore(rows),
    async sendMail(job) {
      mails.push(job.payload as Record<string, unknown>);
    },
    retry() {},
    async openHeadFor() {
      return async function openHead() {
        return { headSha: "sha1", draft: false };
      };
    },
    window: WINDOW,
    setTimer: clock.setTimer,
    now: clock.now,
    log() {},
  });
  return { clock, mails, coalescer };
}

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

test("a late pull_request event naming an older head never moves the head back, in its window or after it", async () => {
  const { clock, mails, coalescer } = harness();
  await coalescer.accept(delivery("updated", "sha2"));
  await coalescer.accept(withAction("updated", "sha1", "edited"));
  await clock.advance(WINDOW.burstMs);
  await coalescer.accept(withAction("updated", "sha1", "review_requested"));
  await clock.advance(WINDOW.quietMs);
  expect(mails.map((mail) => mail.headSha)).toEqual(["sha2", "sha2"]);
});
