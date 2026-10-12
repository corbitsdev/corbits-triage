import { afterEach, expect, jest, test } from "bun:test";
import { environmentManager, isServer, QueriesObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError, type Transport } from "@intx/hub-client";
import { invalidateChangeable, RUN_IDS_QUERY_KEY, RUNS_QUERY_KEY } from "./portal.tsx";
import { runLogQuery, runRefsQuery } from "./run-logs.ts";

const TENANT = "t1";
const WORKSPACE = { tenantId: TENANT, principalId: "p1", userId: "u1" };
const BASE = `/api/tenants/${TENANT}/workflows`;
const started = { seq: 0, type: "RunStarted", body: { at: new Date().toISOString() } };
const ended = [started, { seq: 1, type: "RunCompleted", body: {} }];
const deployment = (id: string, status: string) => ({ id, tenantId: TENANT, definitionAssetId: "asset", status, createdAt: "2026-10-01T00:00:00.000Z" });

const DEPLOYMENTS = [deployment("live", "deployed"), deployment("old", "released")];
const RUNS: Record<string, string[]> = { live: ["live", "done-1", "done-2", "done-3", "busy", "stuck", "settled", "unstarted"], old: ["old", "done-old"] };
const EVENTS: Record<string, unknown[]> = {
  "live": [started, { seq: 1, type: "ChildSpawned", body: {} }],
  "old": [started, { seq: 1, type: "RunCancelled", body: {} }],
  "done-1": ended,
  "done-2": ended,
  "done-3": ended,
  "done-old": ended,
  "busy": [started],
  "stuck": [{ seq: 0, type: "RunStarted", body: { at: "2000-01-01T00:00:00.000Z" } }],
  "settled": [started],
  "unstarted": [],
};
const RUN_STATUSES = [{ id: "settled", definitionId: "def", definitionName: "pr-triage", status: "failed", createdAt: "2026-10-01T00:00:00.000Z" }];

function countingTransport(calls: string[], denied = new Set<string>()): Transport {
  return {
    async fetch<T>(_method: string, path: string): Promise<T> {
      calls.push(path);
      const rel = path.slice(BASE.length + 1).split("/");
      if (denied.has(rel[0] ?? "")) throw new ApiError(403, "forbidden", "forbidden");
      if (rel[0] === "deployments") return DEPLOYMENTS as T;
      if (rel[1] === "runs" && rel.length === 2) return { runIds: RUNS[rel[0] ?? ""] } as T;
      return { runId: rel[2], events: EVENTS[rel[2] ?? ""] } as T;
    },
    subscribe() {
      throw new Error("run logs are read, not subscribed");
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
  environmentManager.setIsServer(() => isServer);
});

test("one tab reads only what can still change over two minutes", async () => {
  // Polling only runs in a browser.
  environmentManager.setIsServer(() => false);
  jest.useFakeTimers();
  const calls: string[] = [];
  const transport = countingTransport(calls);
  const queryClient = new QueryClient();
  queryClient.setQueryData([RUNS_QUERY_KEY, TENANT], RUN_STATUSES);
  const refs = new QueryObserver(queryClient, runRefsQuery(queryClient, transport, WORKSPACE));
  const logs = new QueriesObserver(queryClient, []);
  refs.subscribe((result) => logs.setQueries((result.data ?? []).map((ref) => runLogQuery(queryClient, transport, TENANT, ref))));
  logs.subscribe(() => {});
  for (let second = 0; second <= 120; second++) {
    await flush();
    jest.advanceTimersByTime(1_000);
  }
  await flush();
  const count = (suffix: string) => calls.filter((path) => path.endsWith(suffix)).length;

  expect(count("/deployments")).toBe(41);
  expect(count("/live/runs")).toBe(41);
  expect(count("/old/runs")).toBe(1);
  expect(count("/runs/live/events")).toBe(0);
  expect(count("/runs/done-1/events")).toBe(1);
  expect(count("/runs/done-old/events")).toBe(1);
  expect(count("/runs/busy/events")).toBe(61);
  expect(count("/runs/stuck/events")).toBe(13);
  expect(count("/runs/settled/events")).toBe(13);
  expect(count("/runs/unstarted/events")).toBe(13);
  expect(calls.length).toBe(187);
});

test("a refresh rereads live deployments' run lists and keeps ended ones", async () => {
  const calls: string[] = [];
  const transport = countingTransport(calls);
  const queryClient = new QueryClient();
  await queryClient.fetchQuery(runRefsQuery(queryClient, transport, WORKSPACE));
  await invalidateChangeable(queryClient, [[RUN_IDS_QUERY_KEY]]);
  await queryClient.fetchQuery(runRefsQuery(queryClient, transport, WORKSPACE));
  const count = (suffix: string) => calls.filter((path) => path.endsWith(suffix)).length;

  expect(count("/live/runs")).toBe(2);
  expect(count("/old/runs")).toBe(1);
});

test("an ended deployment read while denied is read again once granted", async () => {
  const denied = new Set(["old"]);
  const queryClient = new QueryClient();
  const transport = countingTransport([], denied);
  const runIds = async () => (await queryClient.fetchQuery(runRefsQuery(queryClient, transport, WORKSPACE))).map((ref) => ref.runId);

  expect(await runIds()).not.toContain("done-old");
  denied.clear();
  await invalidateChangeable(queryClient, [[RUN_IDS_QUERY_KEY]]);
  expect(await runIds()).toContain("done-old");
});
