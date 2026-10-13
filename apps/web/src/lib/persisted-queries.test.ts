import { expect, test } from "bun:test";
import { dehydrate, hydrate, QueryClient, QueryObserver } from "@tanstack/react-query";
import { isOpenPullsAnswered } from "./open-pulls.ts";
import { isPersistedQuery } from "./persisted-queries.ts";

const OPEN = { repos: [{ repo: "o/r", prs: [] }] };

function persistedKeys(client: QueryClient): unknown[] {
  return dehydrate(client, { shouldDehydrateQuery: isPersistedQuery }).queries.map((query) => query.queryKey);
}

test("the open set, its verdicts and finished logs are kept; running logs and other reads are not", () => {
  const client = new QueryClient();
  client.setQueryData(["open-pulls", "t1"], OPEN);
  client.setQueryData(["triage-verdicts", "t1"], { pulls: [], triaged: [] });
  client.setQueryData(["run-ids", "t1", "a"], []);
  client.setQueryData(["run-log", "t1", "a", "done"], { runId: "done", anchorRunId: "a", events: [{ type: "RunCompleted" }] });
  client.setQueryData(["run-log", "t1", "a", "live"], { runId: "live", anchorRunId: "a", events: [{ type: "RunStarted" }] });
  client.setQueryData(["handled-pulls", "t1"], {});
  client.setQueryData(["hidden-dos", "t1"], []);
  client.setQueryData(["approvals", "t1"], []);
  client.setQueryData(["runs", "t1"], []);
  client.getQueryCache().build(client, { queryKey: ["open-pulls", "t2"] });

  expect(persistedKeys(client)).toEqual([
    ["open-pulls", "t1"],
    ["triage-verdicts", "t1"],
    ["run-log", "t1", "a", "done"],
    ["handled-pulls", "t1"],
    ["hidden-dos", "t1"],
  ]);
});

test("a restored open set answers before it is fetched again", () => {
  const before = new QueryClient();
  before.setQueryData(["open-pulls", "t1"], OPEN);
  const after = new QueryClient();
  hydrate(after, dehydrate(before, { shouldDehydrateQuery: isPersistedQuery }));

  const restored = new QueryObserver(after, { queryKey: ["open-pulls", "t1"], enabled: false }).getCurrentResult();
  const empty = new QueryObserver(after, { queryKey: ["open-pulls", "t2"], enabled: false }).getCurrentResult();

  expect(restored.isFetchedAfterMount).toBe(false);
  expect(isOpenPullsAnswered(restored)).toBe(true);
  expect(isOpenPullsAnswered(empty)).toBe(false);
});
