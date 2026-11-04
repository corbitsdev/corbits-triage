import { expect, test } from "bun:test";
import { TriageStats } from "@corbits/triage-contracts";
import { createOutcomeReader, type Host, type OutcomeReaderDeps } from "./pr-outcomes.js";
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
function fakeHost(): Host {
  return {
    async prTimes(number) {
      return { number, author: "alice", createdAt: at(0), closedAt: number === 3 ? null : at(10 * number) };
    },
    async timeline(number) {
      return [
        { kind: "commented", actor: "triage", bot: false, at: at(0.25) },
        { kind: "commented", actor: "dependabot[bot]", bot: true, at: at(0.5) },
        { kind: "commented", actor: "alice", bot: false, at: at(0.75) },
        { kind: "commented", actor: "bob", bot: false, at: at(number) },
        { kind: "reviewed", actor: "carol", bot: false, at: at(number + 2), state: "APPROVED" },
      ];
    },
    async closedBefore() {
      return [];
    },
    botLogins: ["triage"],
  };
}

function route(records: VerdictRecord[], deps: Partial<OutcomeReaderDeps> & Pick<OutcomeReaderDeps, "host">) {
  const outcomes = createOutcomeReader({ enabledAt: async () => ENABLED, now: () => NOW, log: () => {}, ...deps });
  const handle = createTriageStats({ verdicts: { since: async () => records, earliest: async () => ENABLED }, outcomes, now: () => NOW, log: () => {} });
  return async function stats() {
    for (;;) {
      const res = await handle(new Request(`http://hub.test/api/integrations/triage-stats/${TENANT}?repo=${REPO}`), { tenantId: TENANT, principalId: "prn_outcomes" });
      const body = TriageStats.assert(await res.json());
      if (body.outcomes?.state !== "measuring") return body;
      await Bun.sleep(1);
    }
  };
}

test("medians and 75th percentiles count only people other than the author as responses, and humans count each person once across pull requests, leaving bots and the triage user out", async () => {
  const host = fakeHost();
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

test("a failing host leaves the outcomes unavailable and the rest of the stats intact", async () => {
  const logged: Record<string, unknown>[] = [];
  const host = fakeHost();
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
