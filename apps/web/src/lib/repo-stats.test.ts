import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dehydrate, hydrate, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { emptyPack, repoPolicy, type TriageStats } from "@corbits/triage-contracts";
import RulesSection from "../components/repo-panel/RulesSection.tsx";
import { fakeHub } from "./fake-hub.ts";
import { fromPack } from "./pack-draft.ts";
import { isPersistedQuery } from "./persisted-queries.ts";
import { draftPolicy, transportRepoPackStore, type RepoPackStore } from "./repo-pack-store.ts";
import { repoStatsQuery, useRepoStats } from "./repo-stats.ts";
import { usePolicyView } from "./use-policy-view.ts";

const REPO = "o/r";
const PACK = emptyPack(REPO);
const DRAFT = fromPack({ ...PACK, checks: { "max-files-changed": { enabled: true, maxFiles: 30 } } }, draftPolicy(repoPolicy(undefined)));
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
  const view = usePolicyView(DRAFT, noop);
  return createElement(RulesSection, { draft: DRAFT, saved: PACK, view, stats, disabled: false, edit: noop, problem: null });
}

function render(client: QueryClient, store: RepoPackStore): string {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Panel, { store })));
}

function statsRequests(requests: string[]): string[] {
  return requests.filter((request) => request.includes("/triage-stats/"));
}

test("the rules read their weekly pass counts from one request", async () => {
  const hub = fakeHub();
  hub.stats = STATS;
  const store = transportRepoPackStore(hub.transport, "t");
  const client = new QueryClient();
  await client.prefetchQuery(repoStatsQuery(store, REPO, 7));

  const html = render(client, store);

  expect(statsRequests(hub.requests)).toEqual([`GET /api/integrations/triage-stats/t?repo=o%2Fr&days=7`]);
  expect(html).toContain("3 of 4 passed");
});

test("persisted stats render from the cache after a reload", () => {
  const store = transportRepoPackStore(fakeHub().transport, "t");
  const before = new QueryClient();
  before.setQueryData(repoStatsQuery(store, REPO, 7).queryKey, STATS);
  const persisted = dehydrate(before, { shouldDehydrateQuery: isPersistedQuery });
  expect(persisted.queries.map((query) => query.queryKey)).toEqual([["triage-stats", "t", REPO, 7]]);

  const after = new QueryClient();
  hydrate(after, persisted);

  expect(render(after, store)).toContain("3 of 4 passed");
});
