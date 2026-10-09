import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { Transport } from "@intx/hub-client";
import { runRefsQuery } from "./run-logs.ts";

const TENANT = "t1";
const BASE = `/api/tenants/${TENANT}/workflows`;

function transportFor(state: { status: string; runIds: string[] }): Transport {
  return {
    async fetch<T>(_method: string, path: string): Promise<T> {
      const rel = path.slice(BASE.length + 1).split("/");
      if (rel[0] === "deployments") return [{ id: "dep", tenantId: TENANT, definitionAssetId: "a", status: state.status, createdAt: "2026-10-01T00:00:00.000Z" }] as T;
      return { runIds: state.runIds } as T;
    },
    subscribe() {
      throw new Error("unused");
    },
  };
}

test("a deployment that passes through pending/recovering keeps its current run list", async () => {
  const state = { status: "pending", runIds: ["dep"] };
  const transport = transportFor(state);
  const queryClient = new QueryClient();
  const read = async () => (await queryClient.fetchQuery({ ...runRefsQuery(queryClient, transport, TENANT), staleTime: 0 })).map((ref) => ref.runId);

  expect(await read()).toEqual([]);
  state.status = "deployed";
  state.runIds = ["dep", "c1", "c2"];
  expect(await read()).toEqual(["c1", "c2"]);
  // Sidecar replacement: the hub reports the same deployment as recovering.
  state.status = "recovering";
  state.runIds = ["dep", "c1", "c2", "c3"];
  expect(await read()).toEqual(["c1", "c2", "c3"]);
});
