import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { Transport } from "./hub-transport.ts";
import { POLICY_UPGRADES_QUERY_KEY } from "./policy-upgrades.ts";
import { hubRepoPackStore } from "./repo-pack.ts";

test("turning triage on reads the policy file standing again, which lists only enabled repositories", async () => {
  let config: Record<string, unknown> = { corbitsTriage: { repos: [{ name: "acme/widgets", connected: true, enabled: false, installationId: 9 }] } };
  const transport: Transport = {
    async fetch(method, path, body) {
      if (path !== "/api/tenants/tenant") throw new Error(`unexpected ${method} ${path}`);
      if (method === "GET") return { id: "tenant", name: "Tenant", slug: "tenant", config } as never;
      config = (body as { config: Record<string, unknown> }).config;
      return undefined as never;
    },
    subscribe: () => () => {},
  };
  const queryClient = new QueryClient();
  const upgrades = [POLICY_UPGRADES_QUERY_KEY, "tenant"];
  queryClient.setQueryData(upgrades, { rows: [], settled: [] });
  await hubRepoPackStore(queryClient, "tenant", transport).writePolicy("acme/widgets", { enabled: true }, null);
  expect(queryClient.getQueryState(upgrades)?.isInvalidated).toBe(true);
});
