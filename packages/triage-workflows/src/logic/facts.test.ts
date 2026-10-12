import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack } from "@corbits/triage-contracts";
import type { IssueComment, Review } from "@corbits/github-tool";
import { assembleItem, buildFacts } from "./facts.ts";

test("buildFacts carries the author's trust tier", () => {
  const facts = buildFacts("acme/widgets", 1, { author: "alice", authorAssociation: "MEMBER", branch: "a" }, [], [], [], [], DEFAULT_REPO_POLICY);
  expect(facts.tier).toBe("internal");
});

test("assembleItem turns an unreadable file list into an error item", () => {
  const context = { repo: "acme/widgets", openPrs: [], policy: DEFAULT_REPO_POLICY, pack: emptyPack("acme/widgets"), events: [] };
  const pull = { pr: { author: "alice", branch: "a", sha: "abc" }, checks: [], reviews: [], comments: [], commits: [{ message: "fix: a\n\nbody" }], authorTeams: null };
  expect(assembleItem(8, { ...pull, files: "github_list_pr_files result was truncated for #8" }, context)).toEqual({ error: "github_list_pr_files result was truncated for #8" });
  const item = assembleItem(8, { ...pull, files: [{ path: "src/a.ts" }] }, context);
  expect(item).toMatchObject({ facts: { number: 8, headSha: "abc", paths: ["src/a.ts"], commits: ["fix: a"] } });
});

test("assembleItem maps team membership back to every spelling and leaves every team unknown without a read", () => {
  const policy = { ...DEFAULT_REPO_POLICY, roles: { core: { teams: ["@acme/Core", "ops"] }, staff: { teams: ["core", "@other/x"] } } };
  const context = { repo: "acme/widgets", openPrs: [], policy, pack: emptyPack("acme/widgets"), events: [] };
  const pull = { pr: { author: "alice", branch: "a", sha: "abc" }, checks: [], reviews: [], comments: [], commits: [], files: [] };
  const all = ["@acme/Core", "ops", "core", "@other/x"];
  expect(assembleItem(8, { ...pull, authorTeams: { teams: ["core"], unknown: [] } }, context)).toMatchObject({ facts: { authorTeams: ["@acme/Core", "core"], authorTeamsUnknown: ["@other/x"] } });
  expect(assembleItem(8, { ...pull, authorTeams: null }, context)).toMatchObject({ facts: { authorTeams: [], authorTeamsUnknown: all } });
  expect(assembleItem(8, { ...pull, authorTeams: { teams: "core" } }, context)).toMatchObject({ facts: { authorTeams: [], authorTeamsUnknown: all } });
});

describe("an answered review", () => {
  const requested: Review = { reviewer: "maya", state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T10:00:00Z", commitId: "abc" };

  function answered(reviews: Review[], comments: Array<Partial<IssueComment>> = [], sha = "abc"): boolean | undefined {
    const rows = comments.map((c) => ({ id: 1, author: "alice", bot: false, body: "", createdAt: "2026-10-01T11:00:00Z", ...c }));
    return buildFacts("acme/widgets", 1, { author: "alice", branch: "a", sha }, [], reviews, rows, [], DEFAULT_REPO_POLICY).reviewAnswered;
  }

  test("is the author's push, comment or review-thread reply after the request", () => {
    expect(answered([requested])).toBe(false);
    expect(answered([requested], [], "def")).toBe(true);
    expect(answered([requested], [{}])).toBe(true);
    expect(answered([requested, { reviewer: "alice", state: "COMMENTED", submittedAt: "2026-10-01T11:00:00Z", commitId: "abc" }])).toBe(true);
  });

  test("is not a bot's or a maintainer's comment, or one from before the request", () => {
    expect(answered([requested], [{ author: "ci[bot]", bot: true }, { author: "maya" }, { createdAt: "2026-10-01T09:00:00Z" }])).toBe(false);
  });
});
