import { expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dehydrate, hydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defaultActions, emptyPack, repoPolicy, type TriageStats } from "@corbits/triage-contracts";
import VerdictList from "../components/repo-panel/VerdictList.tsx";
import ChecksSection from "../components/repo-panel/ChecksSection.tsx";
import TriageStrip from "../components/repo-panel/TriageStrip.tsx";
import { fakeHub } from "./fake-hub.ts";
import { fromPack } from "./pack-draft.ts";
import { isPersistedQuery } from "./persisted-queries.ts";
import { draftPolicy, transportRepoPackStore, type RepoPackStore } from "./repo-pack-store.ts";
import { repoStatsQuery, useRepoStats } from "./repo-stats.ts";

const REPO = "o/r";
const DRAFT = fromPack({ ...emptyPack(REPO), actions: { ...defaultActions(), pass: [{ kind: "comment", target: { body: "hi" } }] } }, draftPolicy(repoPolicy(undefined)));
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
  medianTimeToVerdictMs: 4_320_000,
  daily: [0, 1, 0, 2, 0, 0, 2].map((triaged, i) => ({ date: `2026-10-0${i + 1}`, triaged })),
};

function noop() {}

function Panel({ store }: { store: RepoPackStore }) {
  const stats = useRepoStats(store, REPO);
  return createElement(Fragment, null,
    createElement(TriageStrip, { stats }),
    createElement(ChecksSection, { draft: DRAFT, saved: DRAFT.pack, stats, disabled: false, edit: noop, problem: null }),
    createElement(VerdictList, { list: "pass", dos: DRAFT.pack.actions.pass, roles: [], alone: undefined, fired: stats?.actions.pass, disabled: false, onChange: noop }),
  );
}

function render(client: QueryClient, store: RepoPackStore): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Panel, { store })));
}

function statsRequests(requests: string[]): string[] {
  return requests.filter((request) => request.includes("/triage-stats/"));
}

test("the strip, the rules and the pass list read one request", async () => {
  const hub = fakeHub();
  hub.stats = STATS;
  const store = transportRepoPackStore(hub.transport, "t");
  const client = new QueryClient();
  await client.prefetchQuery(repoStatsQuery(store, REPO, 7));

  const html = render(client, store);

  expect(statsRequests(hub.requests)).toEqual([`GET /api/integrations/triage-stats/t?repo=o%2Fr&days=7`]);
  expect(html).toContain("Median to verdict");
  expect(html).toContain("1h 12m");
  expect(html).toContain("Passed 3 of 4 this week");
  expect(html).toContain("Fired 2 times, 1 done");
});

test("persisted stats render from the cache after a reload", () => {
  const store = transportRepoPackStore(fakeHub().transport, "t");
  const before = new QueryClient();
  before.setQueryData(repoStatsQuery(store, REPO, 7).queryKey, STATS);
  const persisted = dehydrate(before, { shouldDehydrateQuery: isPersistedQuery });
  expect(persisted.queries.map((query) => query.queryKey)).toEqual([["triage-stats", "t", REPO, 7]]);

  const after = new QueryClient();
  hydrate(after, persisted);

  expect(render(after, store)).toContain("Passed 3 of 4 this week");
});

test("a window with nothing triaged is one line, never zeros", () => {
  const html = renderToStaticMarkup(createElement(TriageStrip, { stats: { ...STATS, triaged: 0, neededYou: 0, actions: {}, checks: {}, comments: 0, medianTimeToVerdictMs: null } }));
  expect(html).toBe('<p class="hint strip">No pull requests triaged in the last 7 days.</p>');
});
