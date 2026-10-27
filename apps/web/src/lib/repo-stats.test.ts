import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dehydrate, hydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RepoSource, TriageStats } from "@corbits/triage-contracts";
import OutcomesCard from "../components/repo-panel/OutcomesCard.tsx";
import { fakeHub } from "./fake-hub.ts";
import { isPersistedQuery } from "./persisted-queries.ts";
import { repoStatsQuery, useRepoStats, type StatsReader } from "./repo-stats.ts";

const REPO = "o/r";
const STATS: TriageStats = {
  repo: REPO,
  days: 7,
  since: "2026-01-01T00:00:00.000Z",
  triaged: 5,
  verdicts: { ready: 3, blocked: 2 },
  neededYou: 2,
  checks: { "max-files-changed": { pass: 3, fail: 1, unconfirmed: 0 } },
  actions: { pass: { suggested: 2, executed: 1, failed: 0 } },
  comments: 4,
  outcomes: {
    state: "measured",
    triaged: {
      prs: 3, closed: 2, mergeOrCloseMs: 90_000_000, firstHumanResponseMs: 3_600_000, firstApprovalMs: null, humanTouchGapMs: 7_200_000, reviewerWaitMs: 1_800_000,
      p75: { mergeOrCloseMs: 172_800_000, firstHumanResponseMs: 3_600_000, firstApprovalMs: null, humanTouchGapMs: 7_200_000, reviewerWaitMs: 5_400_000 },
    },
    humans: 4,
    baseline: null,
    baselineBefore: "2026-01-01T00:00:00.000Z",
    baselineState: "measured",
  },
  daily: [0, 1, 0, 2, 0, 0, 2].map((triaged, i) => ({ date: `2026-10-0${i + 1}`, triaged })),
};

function Panel({ store }: { store: StatsReader }) {
  const stats = useRepoStats(store, REPO);
  return stats ? createElement(OutcomesCard, { outcomes: stats.outcomes, source: "github" }) : null;
}

function render(client: QueryClient, store: StatsReader): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Panel, { store })));
}

function statsRequests(requests: string[]): string[] {
  return requests.filter((request) => request.includes("/triage-stats/"));
}

test("the outcomes read the weekly stats from one request", async () => {
  const hub = fakeHub();
  hub.stats = STATS;
  const store = { tenantId: "t", transport: hub.transport };
  const client = new QueryClient();
  await client.prefetchQuery(repoStatsQuery(store, REPO, 7));

  const html = render(client, store);

  expect(statsRequests(hub.requests)).toEqual([`GET /api/integrations/triage-stats/t?repo=o%2Fr&days=7`]);
  expect(html).toContain("3 PRs, 2 closed");
});

test("persisted stats render from the cache after a reload", () => {
  const store = { tenantId: "t", transport: fakeHub().transport };
  const before = new QueryClient();
  before.setQueryData(repoStatsQuery(store, REPO, 7).queryKey, STATS);
  const persisted = dehydrate(before, { shouldDehydrateQuery: isPersistedQuery });
  expect(persisted.queries.map((query) => query.queryKey)).toEqual([["triage-stats", "t", REPO, 7]]);

  const after = new QueryClient();
  hydrate(after, persisted);

  expect(render(after, store)).toContain("3 PRs, 2 closed");
});

test("the outcomes show the triaged medians with their counts, and each missing state as one sentence", () => {
  const card = (outcomes: TriageStats["outcomes"], source: RepoSource = "github") => renderToStaticMarkup(createElement(OutcomesCard, { outcomes, source }));
  const measured = STATS.outcomes;
  if (measured === null || measured.state !== "measured") throw new Error("fixture outcomes are measured");
  const html = card(measured);
  expect(html).toContain("3 PRs, 2 closed");
  expect(html).toContain("1d 1h <span>P75 2d</span>");
  expect(html).toContain("Waiting on reviewer</th><td>30m <span>P75 1h 30m</span></td><td></td>");
  expect(html).toContain("4 people involved");
  expect(html).toContain("No pull requests closed before Triage was switched on.");

  expect(card({ ...measured, baselineBefore: null, baselineState: "no_policy" })).toContain("The baseline needs a saved policy.");
  expect(card({ ...measured, baselineState: "source_failed" }, "bitbucket-datacenter")).toContain("Bitbucket did not answer; the numbers will return when it does.");
  expect(card({ state: "no_credential" }, "bitbucket-datacenter")).toContain("Needs a Bitbucket credential you can use.");
  expect(card({ state: "source_failed" })).toContain("GitHub did not answer; the numbers will return when it does.");
  expect(card(null)).toContain("Not connected to GitHub.");
  expect(card({ state: "measuring" })).toBe("");
});
