import { expect, test } from "bun:test";
import type { CorbitsTriageNs } from "../github/tenant-config.js";
import { disconnect, enableRepo, listedRepos } from "./records.js";

const ns: CorbitsTriageNs = {
  bitbucket: { baseUrl: "https://bitbucket.example" },
  repos: [
    { name: "acme/app", connected: true, enabled: true },
    { name: "TRI/widgets", connected: true, source: "bitbucket", enabled: true, defaultBranch: "main", webhookId: 7, checks: { ci: false, conflicts: true } },
    { name: "TRI/gone", connected: true, source: "bitbucket", enabled: false },
  ],
};

test("lists the instance's repositories with their records, and recorded ones it no longer sees as disconnected", () => {
  expect(listedRepos(ns, ["TRI/widgets", "TRI/new"]).map((row) => [row.name, row.connected, row.enabled ?? false])).toEqual([
    ["TRI/widgets", true, true],
    ["TRI/new", true, false],
    ["TRI/gone", false, false],
  ]);
});

test("enabling keeps a recorded repository's settings and replaces its webhook", () => {
  const next = enableRepo(ns, "TRI/widgets", "develop", undefined);
  expect(next.repos?.find((row) => row.name === "TRI/widgets")).toEqual({
    name: "TRI/widgets", connected: true, source: "bitbucket", enabled: true, defaultBranch: "develop", checks: { ci: false, conflicts: true },
  });
});

test("disconnecting disables only Bitbucket repositories and forgets their webhooks", () => {
  const next = disconnect(ns);
  expect(next.bitbucket).toBeUndefined();
  expect(next.repos?.map((row) => [row.name, row.enabled, row.webhookId])).toEqual([
    ["acme/app", true, undefined],
    ["TRI/widgets", false, undefined],
    ["TRI/gone", false, undefined],
  ]);
});
