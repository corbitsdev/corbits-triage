import { expect, test } from "bun:test";
import { TriageStats, type TriageOutcomes } from "@corbits/triage-contracts";
import type { OutcomeReader } from "./pr-outcomes.js";
import { createTriageStats } from "./triage-stats.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const MEASURED: TriageOutcomes = {
  state: "measured",
  triaged: {
    prs: 0, closed: 0, mergeOrCloseMs: null, firstHumanResponseMs: null, firstApprovalMs: null, humanTouchGapMs: null, reviewerWaitMs: null,
    p75: { mergeOrCloseMs: null, firstHumanResponseMs: null, firstApprovalMs: null, humanTouchGapMs: null, reviewerWaitMs: null },
  },
  humans: 0,
  baseline: null,
  baselineBefore: null,
  baselineState: "no_policy",
};

function route(read: OutcomeReader["read"], clock = { now: NOW }) {
  const logged: Record<string, unknown>[] = [];
  async function refusal({ principalId }: { principalId: string }) {
    return principalId === "refused" ? { state: "no_credential" as const } : undefined;
  }
  const handle = createTriageStats({ verdicts: { since: async () => [], earliest: async () => null }, outcomes: { refusal, read }, now: () => clock.now, log: (entry) => logged.push(entry) });
  async function stats(principalId = "p") {
    const res = await handle(new Request("http://hub.test/api/integrations/triage-stats/t?repo=o/r"), { tenantId: "t", principalId });
    return TriageStats.assert(await res.json()).outcomes;
  }
  return { stats, logged };
}

test("outcomes are measured in the background, once per repository, and served once ready to members who may read it", async () => {
  const read = Promise.withResolvers<TriageOutcomes>();
  let calls = 0;
  const { stats } = route(async function outcomes() {
    calls += 1;
    return read.promise;
  });

  expect(await stats()).toEqual({ state: "measuring" });
  expect(await stats("q")).toEqual({ state: "measuring" });
  expect(calls).toBe(1);
  read.resolve(MEASURED);
  await read.promise;
  expect(await stats("q")).toEqual(MEASURED);
  expect(await stats("refused")).toEqual({ state: "no_credential" });
  expect(calls).toBe(1);
});

test("a failed measurement stays measuring and is retried after a backoff", async () => {
  let calls = 0;
  const clock = { now: NOW };
  const { stats, logged } = route(async function outcomes() {
    calls += 1;
    if (calls === 1) throw new Error("github 502");
    return MEASURED;
  }, clock);

  expect(await stats()).toEqual({ state: "measuring" });
  expect(await stats()).toEqual({ state: "measuring" });
  expect(calls).toBe(1);
  expect(logged).toMatchObject([{ msg: "triage_outcomes_failed", repo: "o/r", error: "github 502" }]);
  clock.now = new Date(NOW.getTime() + 10_000);
  expect(await stats()).toEqual({ state: "measuring" });
  expect(calls).toBe(2);
  expect(await stats()).toEqual(MEASURED);
});
