import { expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack } from "@corbits/triage-contracts";
import { assembleItem, buildFacts } from "./facts.ts";

test("buildFacts carries the author's trust tier", () => {
  const facts = buildFacts("acme/widgets", 1, { author: "alice", authorAssociation: "MEMBER", branch: "a" }, [], [], [], DEFAULT_REPO_POLICY);
  expect(facts.tier).toBe("internal");
});

test("assembleItem turns an unreadable file list into an error item", () => {
  const context = { repo: "acme/widgets", openPrs: [], policy: DEFAULT_REPO_POLICY, pack: emptyPack("acme/widgets"), event: null };
  const pull = { pr: { author: "alice", branch: "a", sha: "abc" }, checks: [], reviews: [], commits: [{ message: "fix: a\n\nbody" }] };
  expect(assembleItem(8, { ...pull, files: "github_list_pr_files result was truncated for #8" }, context)).toEqual({ error: "github_list_pr_files result was truncated for #8" });
  const item = assembleItem(8, { ...pull, files: [{ path: "src/a.ts" }] }, context);
  expect(item).toMatchObject({ facts: { number: 8, headSha: "abc", paths: ["src/a.ts"], commits: ["fix: a"] } });
});
