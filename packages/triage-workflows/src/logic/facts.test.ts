import { expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack } from "@corbits/triage-contracts";
import { assembleItem, buildFacts } from "./facts.ts";

test("buildFacts carries the author's trust tier", () => {
  const facts = buildFacts("acme/widgets", 1, { author: "alice", authorAssociation: "MEMBER", branch: "a" }, [], [], [], DEFAULT_REPO_POLICY);
  expect(facts.tier).toBe("internal");
});

test("assembleItem turns an unreadable file list into an error item", () => {
  const context = { repo: "acme/widgets", openPrs: [], policy: DEFAULT_REPO_POLICY, pack: emptyPack("acme/widgets"), events: [] };
  const pull = { pr: { author: "alice", branch: "a", sha: "abc" }, checks: [], reviews: [], commits: [{ message: "fix: a\n\nbody" }], authorTeams: null };
  expect(assembleItem(8, { ...pull, files: "github_list_pr_files result was truncated for #8" }, context)).toEqual({ error: "github_list_pr_files result was truncated for #8" });
  const item = assembleItem(8, { ...pull, files: [{ path: "src/a.ts" }] }, context);
  expect(item).toMatchObject({ facts: { number: 8, headSha: "abc", paths: ["src/a.ts"], commits: ["fix: a"] } });
});

test("assembleItem maps team membership back to every spelling and leaves every team unknown without a read", () => {
  const policy = { ...DEFAULT_REPO_POLICY, roles: { core: { teams: ["@acme/Core", "ops"] }, staff: { teams: ["core", "@other/x"] } } };
  const context = { repo: "acme/widgets", openPrs: [], policy, pack: emptyPack("acme/widgets"), events: [] };
  const pull = { pr: { author: "alice", branch: "a", sha: "abc" }, checks: [], reviews: [], commits: [], files: [] };
  const all = ["@acme/Core", "ops", "core", "@other/x"];
  expect(assembleItem(8, { ...pull, authorTeams: { teams: ["core"], unknown: [] } }, context)).toMatchObject({ facts: { authorTeams: ["@acme/Core", "core"], authorTeamsUnknown: ["@other/x"] } });
  expect(assembleItem(8, { ...pull, authorTeams: null }, context)).toMatchObject({ facts: { authorTeams: [], authorTeamsUnknown: all } });
  expect(assembleItem(8, { ...pull, authorTeams: { teams: "core" } }, context)).toMatchObject({ facts: { authorTeams: [], authorTeamsUnknown: all } });
});
