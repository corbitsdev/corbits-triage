import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, recommendedPack, repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { deriveState, REVIEW_ANSWERED_REASON, type PrFacts } from "./checks.ts";

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
  checks: "failure",
  approvals: 0,
};

const allOff: RepoPolicy = {
  cleanupMode: "human-approved",
  enabled: true,
  triageDrafts: true,
  checks: {
    ci: false,
    conflicts: false,
  },
  approvedAuthors: [],
};

function only(check: keyof RepoPolicy["checks"]): RepoPolicy {
  return { ...allOff, checks: { ...allOff.checks, [check]: true } };
}

describe("deriveState policy", () => {
  test("default policy runs every check", () => {
    expect(deriveState(noisy)).toEqual(deriveState(noisy, DEFAULT_REPO_POLICY));
    expect(deriveState(noisy)).toEqual(deriveState(noisy, repoPolicy(undefined)));
    expect(deriveState(noisy).findings.map((finding) => finding.check)).toEqual([
      "checks",
      "conflicts",
    ]);
  });

  test("skips a finding when that check is disabled; the draft check always runs", () => {
    const off = deriveState(noisy, allOff);
    expect(off.findings).toEqual([]);
    expect(off.checks).toEqual([{ check: "draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [], output: { kind: "values", values: { isDraft: true } } }, expect.objectContaining({ check: "review" })]);
    expect(deriveState(noisy, only("ci")).findings.map((finding) => finding.check)).toEqual(["checks"]);
    expect(deriveState(noisy, only("conflicts")).findings.map((finding) => finding.check)).toEqual(["conflicts"]);
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
      checks: "success",
      approvals: 1,
    };
    expect(deriveState(unknown).findings.map((finding) => finding.check)).toEqual(["conflicts"]);
    expect(deriveState(unknown).checks.find((check) => check.check === "conflicts")?.output).toEqual({ kind: "could-not-check", reason: "mergeability not yet computed" });
    expect(deriveState(unknown, allOff).findings).toEqual([]);
  });
});

describe("deriveState check pack", () => {
  test("empty valid pack classifies with no catalog findings", () => {
    const result = deriveState(noisy, DEFAULT_REPO_POLICY, emptyPack("acme/widgets"));
    expect(result.findings).toEqual([]);
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
      "conflicts",
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
      reason: "pull request is over the size limits",
      evidence: ["80 files (max 30)"],
      output: { kind: "values", values: { files: 80, lines: 20 } },
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
    labels: ["API"],
    approvals: 1,
    paths: ["src/api.ts", "docs/api.md"],
    files: [
      { path: "src/api.ts", additions: 2, patch: "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n@@ -10,1 +10,2 @@\n c\n+const token = 'sk-live-1';" },
      { path: "docs/api.md", additions: 1, patch: "@@ -1 +1,2 @@\n x\n+y" },
    ],
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
    { id: "custom-8", name: "API label", group: "issue", kind: "rule", rule: "label-required", label: "api" },
  ];

  test("each rule kind is evaluated from facts, named in its reason, with a finding on failure", () => {
    const result = deriveState(facts, allOff, pack);
    const byId = Object.fromEntries(result.checks.map((check) => [check.check, check]));
    expect(byId["custom-1"]).toMatchObject({ kind: "machine", result: "pass" });
    expect(byId["custom-2"]).toMatchObject({ result: "pass" });
    expect(byId["custom-3"]).toMatchObject({ result: "pass" });
    expect(byId["custom-4"]).toMatchObject({ result: "fail", reason: "Branch naming: branch does not match the pattern" });
    expect(byId["custom-5"]).toMatchObject({ result: "fail", reason: "Needs triage label: label triaged is missing" });
    expect(byId["custom-6"]).toMatchObject({ result: "fail", evidence: ["src/api.ts:11"] });
    expect(byId["custom-7"]).toMatchObject({ result: "fail", reason: "Two approvals: not enough approvals", evidence: ["1 of 2 approvals"] });
    expect(byId["custom-8"]).toMatchObject({ result: "pass" });
    expect(byId["custom-4"]!.output).toEqual({ kind: "values", values: { holds: false } });
    expect(byId["custom-7"]!.output).toEqual({ kind: "values", values: { holds: false, approvals: 1 } });
    expect(byId["custom-1"]!.output).toEqual({ kind: "values", values: { holds: true } });
    expect(result.findings.map((finding) => [finding.check, finding.state])).toEqual([
      ["custom-4", "needs-author-update"],
      ["custom-5", "awaiting-review"],
      ["custom-6", "needs-author-update"],
      ["custom-7", "awaiting-review"],
    ]);
    expect(result.sources?.rules).toEqual(pack.custom);
  });

  test("a hit in a truncated patch still fails; only a clean scan with gaps is unconfirmed", () => {
    const truncated: PrFacts = { ...facts, files: [{ ...facts.files![0]!, patchTruncated: true }] };
    expect(deriveState(truncated, allOff, pack).checks.find((check) => check.check === "custom-6")).toMatchObject({ result: "fail", evidence: ["src/api.ts:11"] });
    const gaps: PrFacts = { ...facts, branch: undefined, files: [{ path: "src/api.ts", additions: 2 }, { path: "img.png", additions: 0 }] };
    const result = deriveState(gaps, allOff, pack);
    expect(result.checks.find((check) => check.check === "custom-4")?.result).toBe("unconfirmed");
    expect(result.checks.find((check) => check.check === "custom-6")?.result).toBe("unconfirmed");
    expect(result.checks.find((check) => check.check === "custom-6")?.output).toEqual({ kind: "could-not-check", reason: "some added lines could not be scanned" });
  });

  test("a pattern that backtracks under RegExp matches a long added line in linear time", () => {
    const slow = emptyPack("acme/widgets");
    slow.custom = [{ id: "custom-1", name: "Digits", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "\\d+\\d+\\d+x" }];
    const started = performance.now();
    const result = deriveState({ ...facts, files: [{ path: "src/api.ts", additions: 1, patch: `@@ -1 +1 @@\n+${"1".repeat(2_000)}` }] }, allOff, slow);
    expect(performance.now() - started).toBeLessThan(250);
    expect(result.checks[0]?.result).toBe("pass");
  });

  test("author rules gate on people, roles or kinds and never add a finding", () => {
    const gated = emptyPack("acme/widgets");
    gated.custom = [
      { id: "custom-1", name: "Mine", group: "pull-request", kind: "rule", rule: "author", who: "users", users: ["Octocat"] },
      { id: "custom-2", name: "Core", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "core" },
      { id: "custom-3", name: "Agents", group: "pull-request", kind: "rule", rule: "author", who: "kinds", kinds: ["bot"] },
      { id: "custom-4", name: "Staff", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "staff" },
      { id: "custom-5", name: "Gone", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "gone" },
    ];
    const bot: PrFacts = { ...facts, authorKind: "bot" };
    const result = deriveState(bot, allOff, gated, { core: { users: ["alice"] }, staff: { users: ["alice"], teams: ["@acme/staff"] } });
    const byId = Object.fromEntries(result.checks.map((check) => [check.check, check]));
    expect(byId["custom-1"]).toMatchObject({ result: "pass", evidence: ["@octocat (bot)"], gate: true });
    expect(byId["custom-2"]).toMatchObject({ result: "fail", reason: "Core: author is not one of the people named" });
    expect(byId["custom-3"]).toMatchObject({ result: "pass", reason: "Agents: author is bot" });
    expect(byId["custom-4"]).toMatchObject({ result: "unconfirmed", reason: "Staff: team membership of @acme/staff is not known" });
    expect(byId["custom-5"]).toMatchObject({ result: "unconfirmed", reason: "Gone: role gone is not defined" });
    expect(deriveState({ ...facts, authorKind: undefined }, allOff, gated).checks.find((check) => check.check === "custom-3")?.result).toBe("unconfirmed");
    expect(result.findings).toEqual([]);
    expect(result.state).toBe("ready-monitoring");
  });

  test("a role with teams answers from the author's confirmed team membership", () => {
    const gated = emptyPack("acme/widgets");
    gated.custom = [{ id: "custom-1", name: "Staff", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "staff" }];
    const roles = { staff: { users: ["alice"], teams: ["@acme/staff", "ops"] } };
    function staff(membership: Pick<PrFacts, "authorTeams" | "authorTeamsUnknown">) {
      return deriveState({ ...facts, ...membership }, allOff, gated, roles).checks.find((check) => check.check === "custom-1");
    }
    expect(staff({ authorTeams: ["ops"], authorTeamsUnknown: ["@acme/staff"] })).toMatchObject({ result: "pass", reason: "Staff: author is in team ops", gate: true });
    expect(staff({ authorTeams: [], authorTeamsUnknown: [] })).toMatchObject({ result: "fail", reason: "Staff: author is not one of the people or teams named", gate: true });
    expect(staff({ authorTeams: [], authorTeamsUnknown: ["ops"] })).toMatchObject({ result: "unconfirmed", reason: "Staff: team membership of ops is not known" });
  });
});

describe("deriveState check output", () => {
  test("each fact is named for what it states, so pending CI never reads as passing", () => {
    const pack = recommendedPack("acme/widgets");
    pack.checks.paths = { enabled: true, forbiddenGlobs: ["vendor/**"] };
    pack.custom = [{ id: "custom-1", name: "No vendor", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["vendor/**"] }];
    const facts: PrFacts = { ...noisy, checks: "pending", mergeable: true, paths: ["vendor/x.ts"], changedFiles: 1, additions: 1, deletions: 0 };
    const outputs = Object.fromEntries(deriveState(facts, undefined, pack).checks.map((check) => [check.check, check.output]));
    expect(outputs).toMatchObject({
      draft: { kind: "values", values: { isDraft: true } },
      ci: { kind: "values", values: { status: "pending" } },
      conflicts: { kind: "values", values: { hasConflicts: false } },
      paths: { kind: "values", values: { touchesForbiddenPaths: true } },
      size: { kind: "values", values: { files: 1, lines: 1 } },
      "custom-1": { kind: "values", values: { holds: false } },
    });
  });
});

describe("review check", () => {
  test("keeps the author's turn on requested changes and names an answered review", () => {
    const requested = { ...noisy, changesRequested: ["maya"] };
    const review = (facts: PrFacts) => deriveState(facts, allOff).checks.find((check) => check.check === "review");
    expect(review(requested)).toMatchObject({ result: "fail", reason: "a reviewer requested changes" });
    expect(review({ ...requested, reviewAnswered: true })).toMatchObject({ result: "fail", reason: REVIEW_ANSWERED_REASON });
    expect(deriveState({ ...requested, reviewAnswered: true }, allOff).state).toBe("needs-author-update");
  });
});
