import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, recommendedPack, repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "./checks.ts";

const noisy: PrFacts = {
  repo: "acme/widgets",
  number: 8,
  title: "Fix login",
  author: "octocat",
  tier: "external",
  headSha: "abc",
  state: "open",
  draft: true,
  mergeable: false,
  baseBehindBy: 50,
  checks: "failure",
  requestedReviewers: 0,
  approvals: 0,
  openPrs: [{ number: 7, title: "Fix login" }],
};

const allOff: RepoPolicy = {
  cleanupMode: "human-approved",
  enabled: true,
  triageDrafts: true,
  checks: {
    draft: false,
    ci: false,
    duplicate: false,
    conflicts: false,
    reviewers: false,
    drift: false,
  },
  approvedAuthors: [],
};

function only(check: keyof RepoPolicy["checks"]): RepoPolicy {
  return { ...allOff, checks: { ...allOff.checks, [check]: true } };
}

describe("deriveState policy", () => {
  test("default policy runs every check but reviewers", () => {
    expect(deriveState(noisy)).toEqual(deriveState(noisy, DEFAULT_REPO_POLICY));
    expect(deriveState(noisy)).toEqual(deriveState(noisy, repoPolicy(undefined)));
    expect(deriveState(noisy).findings.map((finding) => finding.check)).toEqual([
      "checks",
      "duplicate",
      "conflicts",
      "drift",
    ]);
  });

  test("skips a finding when that check is disabled", () => {
    const draft = deriveState(noisy, only("draft"));
    expect(draft.findings).toEqual([]);
    expect(draft.checks).toEqual([{ check: "draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [] }, expect.objectContaining({ check: "review" })]);
    expect(deriveState(noisy, only("ci")).findings.map((finding) => finding.check)).toEqual(["checks"]);
    expect(deriveState(noisy, only("duplicate")).findings.map((finding) => finding.check)).toEqual(["duplicate"]);
    expect(deriveState(noisy, only("conflicts")).findings.map((finding) => finding.check)).toEqual(["conflicts"]);
    expect(deriveState(noisy, only("reviewers")).findings.map((finding) => finding.check)).toEqual(["reviewers"]);
    expect(deriveState(noisy, only("drift")).findings.map((finding) => finding.check)).toEqual(["drift"]);
  });

  test("disabled duplicate does not set duplicateOf", () => {
    expect(deriveState(noisy).duplicateOf).toBe(7);
    expect(deriveState(noisy, { ...allOff, checks: { ...allOff.checks, duplicate: false } }).duplicateOf).toBeNull();
  });

  test("closed state check always runs", () => {
    const closed = deriveState({ ...noisy, state: "closed" }, allOff);
    expect(closed.findings).toEqual([{ check: "state", state: "ready-monitoring", reason: "pull request is closed" }]);
  });

  test("skips the mergeability-unknown conflicts finding when conflicts is off", () => {
    const unknown: PrFacts = {
      ...noisy,
      draft: false,
      mergeable: null,
      baseBehindBy: 0,
      checks: "success",
      requestedReviewers: 1,
      approvals: 1,
      openPrs: [],
    };
    expect(deriveState(unknown).findings.map((finding) => finding.check)).toEqual(["conflicts"]);
    expect(deriveState(unknown, allOff).findings).toEqual([]);
  });
});

describe("deriveState check pack", () => {
  test("empty valid pack classifies with no catalog findings", () => {
    const result = deriveState(noisy, DEFAULT_REPO_POLICY, emptyPack("acme/widgets"));
    expect(result.findings).toEqual([]);
    expect(result.duplicateOf).toBeNull();
    expect(result.sources).toEqual({ quality: [], custom: [], rules: [] });
  });

  test("machine checks use pack params; quality and custom are source not code", () => {
    const pack = recommendedPack("acme/widgets");
    pack.custom = [{
      id: "custom-1",
      name: "Bomb",
      group: "pull-request",
      kind: "model",
      shape: "is-true",
      claim: "process.exit(1)",
    }];
    const sized: PrFacts = { ...noisy, changedFiles: 80, additions: 10, deletions: 10, paths: ["src/a.ts"], changesRequested: ["maintainer"] };
    const result = deriveState(sized, allOff, pack);
    expect(result.findings.map((finding) => finding.check)).toEqual([
      "checks",
      "duplicate",
      "conflicts",
      "drift",
      "review",
      "size",
      "issue",
    ]);
    expect(result.checks.find((check) => check.check === "review")).toMatchObject({
      result: "fail",
      evidence: ["changes requested by @maintainer"],
    });
    expect(result.checks.find((check) => check.check === "size")).toEqual({
      check: "size",
      kind: "machine",
      result: "fail",
      reason: "pull request is too large",
      evidence: ["80 files (max 20)"],
    });
    expect(result.checks.find((check) => check.check === "paths")?.result).toBe("pass");
    expect(result.sources?.custom).toEqual(pack.custom);
    expect(result.sources?.quality.map((row) => row.id).sort()).toEqual(["docs", "focused", "tests"]);
  });
});

describe("deriveState rule custom checks", () => {
  const facts: PrFacts = {
    ...noisy,
    draft: false,
    title: "feat(api): add search",
    branch: "feature/search",
    labels: ["api"],
    approvals: 1,
    paths: ["src/api.ts", "docs/api.md"],
    files: [{ path: "src/api.ts", patch: "@@ -1,2 +1,3 @@\n a\n+const token = 'sk-live-1';\n b" }, { path: "docs/api.md", patch: "@@ -1 +1,2 @@\n x\n+y" }],
  };
  const pack = emptyPack("acme/widgets");
  pack.custom = [
    { id: "custom-1", name: "Lockfile frozen", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"] },
    { id: "custom-2", name: "Docs with API", group: "pull-request", kind: "rule", rule: "paths-together", changed: ["src/api.ts"], requires: ["docs/**"] },
    { id: "custom-3", name: "Conventional title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^(feat|fix)\\(" },
    { id: "custom-4", name: "Branch naming", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" },
    { id: "custom-5", name: "Needs triage label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" },
    { id: "custom-6", name: "No live keys", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "sk-live-" },
    { id: "custom-7", name: "Two approvals", group: "around", kind: "rule", rule: "min-approvals", count: 2 },
  ];

  test("each rule kind is evaluated from facts with evidence and a finding on failure", () => {
    const result = deriveState(facts, allOff, pack);
    const byId = Object.fromEntries(result.checks.map((check) => [check.check, check]));
    expect(byId["custom-1"]).toMatchObject({ kind: "machine", result: "pass" });
    expect(byId["custom-2"]).toMatchObject({ result: "pass" });
    expect(byId["custom-3"]).toMatchObject({ result: "pass", evidence: ["feat(api): add search"] });
    expect(byId["custom-4"]).toMatchObject({ result: "fail", evidence: ["feature/search"] });
    expect(byId["custom-5"]).toMatchObject({ result: "fail", evidence: ["api"] });
    expect(byId["custom-6"]).toMatchObject({ result: "fail", evidence: ["src/api.ts:2"] });
    expect(byId["custom-7"]).toMatchObject({ result: "fail", evidence: ["1 of 2 approvals"] });
    expect(result.findings.map((finding) => [finding.check, finding.state])).toEqual([
      ["custom-4", "needs-author-update"],
      ["custom-5", "needs-decision"],
      ["custom-6", "needs-author-update"],
      ["custom-7", "awaiting-review"],
    ]);
    expect(result.sources?.rules).toEqual(pack.custom);
  });

  test("a missing branch or patch leaves the rule unconfirmed", () => {
    const partial: PrFacts = { ...facts, branch: undefined, files: [{ path: "src/api.ts" }] };
    const result = deriveState(partial, allOff, pack);
    expect(result.checks.find((check) => check.check === "custom-4")?.result).toBe("unconfirmed");
    expect(result.checks.find((check) => check.check === "custom-6")?.result).toBe("unconfirmed");
  });
});
