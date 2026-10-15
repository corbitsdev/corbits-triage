import { expect, test } from "bun:test";
import type { CorbitsTriageNs } from "../github/tenant-config.js";
import { disconnect } from "./records.js";

test("disconnecting disables only Bitbucket repositories and forgets their webhooks", () => {
  const ns: CorbitsTriageNs = {
    bitbucketDatacenter: { baseUrl: "https://bitbucket.example" },
    repos: [
      { name: "acme/app", connected: true, enabled: true },
      { name: "TRI/widgets", connected: true, source: "bitbucket-datacenter", enabled: true, webhookId: 7 },
    ],
  };
  const next = disconnect(ns);
  expect(next.bitbucketDatacenter).toBeUndefined();
  expect(next.repos?.map((row) => [row.name, row.enabled, row.webhookId])).toEqual([
    ["acme/app", true, undefined],
    ["TRI/widgets", false, undefined],
  ]);
});
