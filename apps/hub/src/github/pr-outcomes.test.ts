import { expect, test } from "bun:test";
import type { PrTimes, TimelineEvent } from "@corbits/github-reads";
import { TriageStats } from "@corbits/triage-contracts";
import { createOutcomeReader, outcomeOf, type Host, type OutcomeReaderDeps } from "./pr-outcomes.js";
import { createTriageStats } from "./triage-stats.js";
import type { VerdictRecord } from "./verdict-record-store.js";

const TENANT = "tnt_outcomes";
const REPO = "acme/widgets";
const NOW = new Date("2026-10-14T12:00:00Z");
const ENABLED = new Date("2026-09-01T00:00:00Z");
const OPENED = Date.parse("2026-10-01T00:00:00Z");
const HOUR = 3_600_000;

function at(hours: number): string {
  return new Date(OPENED + hours * HOUR).toISOString();
}

function verdict(number: number): VerdictRecord {
  return {
    runId: `run_${number}`, repo: REPO, number, headSha: `sha${number}`, startedAt: new Date(NOW.getTime() - number * 1000), verdictAt: new Date(at(number / 2)),
    settled: true, state: "ready-monitoring", actor: "author", humanGated: false, degraded: null, checks: [], dos: [], commented: false, runStatus: "completed",
  } as unknown as VerdictRecord;
}

/** PR n: given a verdict after n/2 hours, closed after 10n (PR 3 still open), first answered by bob after n hours, approved by carol after n + 2. */
function fakeHost() {
  const reads = { prTimes: 0, timeline: 0, closedBefore: 0, active: 0, peak: 0 };
  async function counted<T>(value: T): Promise<T> {
    reads.active += 1;
    reads.peak = Math.max(reads.peak, reads.active);
    await Bun.sleep(1);
    reads.active -= 1;
    return value;
  }
  const host: Host = {
    async prTimes(number) {
      reads.prTimes += 1;
      return counted<PrTimes>({ number, author: "alice", createdAt: at(0), closedAt: number === 3 ? null : at(10 * number) });
    },
    async timeline(number) {
      reads.timeline += 1;
      return counted<TimelineEvent[]>([
        { kind: "commented", actor: "triage", bot: false, at: at(0.25) },
        { kind: "commented", actor: "dependabot[bot]", bot: true, at: at(0.5) },
        { kind: "commented", actor: "alice", bot: false, at: at(0.75) },
        { kind: "commented", actor: "bob", bot: false, at: at(number) },
        { kind: "reviewed", actor: "carol", bot: false, at: at(number + 2), state: "APPROVED" },
      ]);
    },
    async closedBefore() {
      reads.closedBefore += 1;
      return counted<PrTimes[]>([]);
    },
    botLogins: ["triage"],
  };
  return { host, reads };
}

function route(records: VerdictRecord[], deps: Partial<OutcomeReaderDeps> & Pick<OutcomeReaderDeps, "host">, clock = { now: NOW }) {
  const outcomes = createOutcomeReader({ enabledAt: async () => ENABLED, now: () => clock.now, log: () => {}, ...deps });
  const handle = createTriageStats({ verdicts: { since: async () => records, earliest: async () => ENABLED }, outcomes, now: () => clock.now, log: () => {} });
  return async function stats() {
    for (;;) {
      const res = await handle(new Request(`http://hub.test/api/integrations/triage-stats/${TENANT}?repo=${REPO}`), { tenantId: TENANT, principalId: "prn_outcomes" });
      const body = TriageStats.assert(await res.json());
      if (body.outcomes?.state !== "measuring") return body;
      await Bun.sleep(1);
    }
  };
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await Bun.sleep(1);
}

test("medians and 75th percentiles count only people other than the author as responses, and humans count each person once across pull requests, leaving bots and the triage user out", async () => {
  const { host } = fakeHost();
  const stats = await route([1, 2, 3].map(verdict), { host: async () => ({ host, source: "github" }) })();
  expect(stats.outcomes).toEqual({
    state: "measured",
    triaged: {
      prs: 3, closed: 2, mergeOrCloseMs: 15 * HOUR, firstHumanResponseMs: 2 * HOUR, firstApprovalMs: 4 * HOUR, humanTouchGapMs: 2 * HOUR, reviewerWaitMs: 3 * HOUR,
      p75: { mergeOrCloseMs: 17.5 * HOUR, firstHumanResponseMs: 2.5 * HOUR, firstApprovalMs: 4.5 * HOUR, humanTouchGapMs: 2.125 * HOUR, reviewerWaitMs: 3.25 * HOUR },
    },
    humans: 3,
    baseline: null,
    baselineBefore: ENABLED.toISOString(),
    baselineState: "measured",
  });
});

test("being mentioned or labelled is not a response", () => {
  const events: TimelineEvent[] = [
    { kind: "mentioned", actor: "dave", bot: false, at: at(1) },
    { kind: "labeled", actor: "erin", bot: false, at: at(2) },
    { kind: "commented", actor: "bob", bot: false, at: at(5) },
  ];
  const outcome = outcomeOf({ number: 1, author: "alice", createdAt: at(0), closedAt: null }, events, { author: "alice", botLogins: [] });
  expect(outcome).toMatchObject({ firstHumanResponseMs: 5 * HOUR, humanTouchGapMs: 5 * HOUR });
});

test("the reviewer wait runs from the verdict to the first approval, change request or merge by someone else", () => {
  const pr = { number: 1, author: "alice", createdAt: at(0), closedAt: at(9) };
  const events: TimelineEvent[] = [
    { kind: "commented", actor: "bob", bot: false, at: at(3) },
    { kind: "reviewed", actor: "bob", bot: false, at: at(4), state: "COMMENTED" },
    { kind: "reviewed", actor: "alice", bot: false, at: at(5), state: "APPROVED" },
    { kind: "merged", actor: "carol", bot: false, at: at(9) },
  ];
  expect(outcomeOf(pr, events, { author: "alice", botLogins: [], verdictAt: new Date(at(2)) }).reviewerWaitMs).toBe(7 * HOUR);
  expect(outcomeOf(pr, events, { author: "alice", botLogins: [] }).reviewerWaitMs).toBeNull();
});

test("a review between the run's start and its verdict waited for nothing", () => {
  const pr = { number: 1, author: "alice", createdAt: at(0), closedAt: null };
  const events: TimelineEvent[] = [{ kind: "reviewed", actor: "carol", bot: false, at: at(1.5), state: "CHANGES_REQUESTED" }];
  expect(outcomeOf(pr, events, { author: "alice", botLogins: [], verdictAt: new Date(at(2)) }).reviewerWaitMs).toBe(0);
});

test("only the 50 newest triaged pull requests are read, at most 8 reads at once", async () => {
  const { host, reads } = fakeHost();
  const stats = await route(Array.from({ length: 80 }, (_, i) => verdict(i + 1)), { host: async () => ({ host, source: "github" }), enabledAt: async () => undefined })();
  expect(stats.outcomes).toMatchObject({ state: "measured", triaged: { prs: 50 }, baseline: null, baselineState: "no_policy" });
  expect(reads).toMatchObject({ prTimes: 50, timeline: 50, closedBefore: 0 });
  expect(reads.peak).toBeLessThanOrEqual(8);
});

test("the baseline is read once a day, and closed pull requests are not read again", async () => {
  const { host, reads } = fakeHost();
  host.closedBefore = async function closedBefore() {
    reads.closedBefore += 1;
    return [{ number: 90, author: "alice", createdAt: at(0), closedAt: at(30) }];
  };
  const clock = { now: NOW };
  const stats = route([1, 3].map(verdict), { host: async () => ({ host, source: "github" }) }, clock);
  expect((await stats()).outcomes).toMatchObject({ baseline: { prs: 1, mergeOrCloseMs: 30 * HOUR, firstHumanResponseMs: 90 * HOUR } });
  expect(reads).toMatchObject({ prTimes: 2, timeline: 3, closedBefore: 1 });
  clock.now = new Date(NOW.getTime() + 20 * 60_000);
  await stats();
  await until(() => reads.timeline === 4);
  expect(reads).toMatchObject({ prTimes: 3, timeline: 4, closedBefore: 1 });
});

test("a failing host leaves the outcomes unavailable and the rest of the stats intact", async () => {
  const logged: Record<string, unknown>[] = [];
  const { host } = fakeHost();
  host.timeline = async function timeline() {
    throw new Error("github GET timeline -> 502");
  };
  host.closedBefore = async function closedBefore() {
    throw new Error("github GET search -> 502");
  };
  const stats = await route([1, 2].map(verdict), { host: async () => ({ host, source: "github" }), log: (entry) => logged.push(entry) })();
  expect(stats.triaged).toBe(2);
  expect(stats.outcomes).toEqual({ state: "source_failed" });
  expect(logged).toMatchObject([{ msg: "triage_outcomes_failed", repo: REPO, failed: 3 }]);
});

test("a failed baseline read says so beside the triaged medians", async () => {
  const { host } = fakeHost();
  host.closedBefore = async function closedBefore() {
    throw new Error("github GET search -> 502");
  };
  const stats = await route([1, 2].map(verdict), { host: async () => ({ host, source: "github" }) })();
  expect(stats.outcomes).toMatchObject({ state: "measured", triaged: { prs: 2 }, baseline: null, baselineState: "source_failed" });
});

test("a name on both hosts is measured from the host named, never from the other host's kept reads", async () => {
  const github = fakeHost();
  const bitbucket = fakeHost();
  const outcomes = createOutcomeReader({
    enabledAt: async () => ENABLED,
    now: () => NOW,
    log: () => {},
    async host(_tenantId, _principalId, _repo, source) {
      return source === "bitbucket-datacenter" ? { host: bitbucket.host, source } : { host: github.host, source: "github" };
    },
  });
  const member = { tenantId: TENANT, principalId: "prn_outcomes" } as Parameters<typeof outcomes.read>[0];
  const triaged = [{ number: 1, verdictAt: new Date(at(0.5)) }];
  await outcomes.read(member, REPO, "github", triaged);
  await outcomes.read(member, REPO, "bitbucket-datacenter", triaged);
  expect([github.reads.prTimes, bitbucket.reads.prTimes]).toEqual([1, 1]);
  expect([github.reads.closedBefore, bitbucket.reads.closedBefore]).toEqual([1, 1]);
});
