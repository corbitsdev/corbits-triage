import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { repoPolicy } from "@corbits/triage-contracts";
import { ApiError, type Transport } from "./hub-transport.ts";
import { POLICY_UPGRADES_QUERY_KEY } from "./policy-upgrades.ts";
import { hubRepoPackStore, repoPackSessionQuery } from "./repo-pack.ts";
import { draftPolicy, type LoadedRepoPack, type RepoPackStore } from "./repo-pack-store.ts";

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
  await hubRepoPackStore(queryClient, "tenant", transport).writePolicy("acme/widgets", "github", { enabled: true }, null);
  expect(queryClient.getQueryState(upgrades)?.isInvalidated).toBe(true);
});

test("the policy load recovers from one failed read, and still fails when reads keep failing", async () => {
  const store = { tenantId: "tenant" } as RepoPackStore;
  const pack: LoadedRepoPack = { artifact: null, policy: draftPolicy(repoPolicy(undefined)) };
  let failures = 1;
  async function load() {
    if (failures-- > 0) throw new Error("hub unavailable");
    return pack;
  }
  expect(await new QueryClient().fetchQuery(repoPackSessionQuery(store, "acme/widgets", "github", 0, load))).toBe(pack);
  failures = Infinity;
  await expect(new QueryClient().fetchQuery(repoPackSessionQuery(store, "acme/widgets", "github", 0, load))).rejects.toThrow("hub unavailable");
});

test("the policy load does not retry a rejected session", async () => {
  let reads = 0;
  async function load(): Promise<LoadedRepoPack> {
    reads += 1;
    throw new ApiError(401, "unauthorized", "Sign in again.");
  }
  await expect(new QueryClient().fetchQuery(repoPackSessionQuery({ tenantId: "tenant" } as RepoPackStore, "acme/widgets", "github", 0, load))).rejects.toThrow();
  expect(reads).toBe(1);
});

test("a settled policy upgrade's invalidation by tenant and repository reaches the open policy on either host", async () => {
  const queryClient = new QueryClient();
  const store = { tenantId: "tenant" } as RepoPackStore;
  async function load(): Promise<LoadedRepoPack> {
    return { artifact: null, policy: draftPolicy(repoPolicy(undefined)) };
  }
  const session = repoPackSessionQuery(store, "acme/widgets", "bitbucket-datacenter", 0, load);
  await queryClient.fetchQuery(session);
  await queryClient.invalidateQueries({ queryKey: ["repo-pack-session", "tenant", "acme/widgets"] });
  expect(queryClient.getQueryState(session.queryKey)?.isInvalidated).toBe(true);
});
