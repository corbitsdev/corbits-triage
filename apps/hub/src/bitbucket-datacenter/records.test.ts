import { expect, test } from "bun:test";
import type { CorbitsTriageNs } from "../github/tenant-config.js";
import { bitbucketConnection, disconnect } from "./records.js";

test("disconnecting disconnects and disables only Bitbucket repositories and forgets their webhooks", () => {
  const ns: CorbitsTriageNs = {
    bitbucketDatacenter: { baseUrl: "https://bitbucket.example" },
    repos: [
      { name: "acme/app", connected: true, enabled: true },
      { name: "TRI/widgets", connected: true, source: "bitbucket-datacenter", enabled: true, webhookId: 7 },
    ],
  };
  const next = disconnect(ns);
  expect(next.bitbucketDatacenter).toBeUndefined();
  expect(next.repos?.map((row) => [row.name, row.connected, row.enabled, row.webhookId])).toEqual([
    ["acme/app", true, true, undefined],
    ["TRI/widgets", false, false, undefined],
  ]);
});

test("a stored base URL the connect route would refuse reads back as no connection", () => {
  expect(bitbucketConnection({ bitbucketDatacenter: { baseUrl: "http://169.254.169.254/latest" } })).toBeUndefined();
  expect(bitbucketConnection({ bitbucketDatacenter: { baseUrl: "http://127.0.0.1:7990" } })).toBeUndefined();
  expect(bitbucketConnection({ bitbucketDatacenter: { baseUrl: "http://10.0.0.5:7990" } })).toBeUndefined();
  expect(bitbucketConnection({ bitbucketDatacenter: { baseUrl: "https://bitbucket.example", user: "triage" } })).toEqual({ baseUrl: "https://bitbucket.example", user: "triage" });
});
