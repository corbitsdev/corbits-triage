// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, recommendedPack, repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { deriveState, type PrFacts } from "./checks.ts";

const noisy: PrFacts = {
  repo: "acme/widgets",
  number: 8,
  title: "Fix login",
  author: "octocat",
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
  classificationAuthorized: true,
  checks: {
    draft: false,
    ci: false,
    duplicate: false,
    conflicts: false,
    reviewers: false,
    drift: false,
  },
};

function only(check: keyof RepoPolicy["checks"]): RepoPolicy {
  return { ...allOff, checks: { ...allOff.checks, [check]: true } };
}

describe("deriveState policy", () => {
  test("default policy matches current all-on behavior", () => {
    expect(deriveState(noisy)).toEqual(deriveState(noisy, DEFAULT_REPO_POLICY));
    expect(deriveState(noisy)).toEqual(deriveState(noisy, repoPolicy(undefined)));
    expect(deriveState(noisy).findings.map((finding) => finding.check)).toEqual([
      "draft",
      "checks",
      "duplicate",
      "conflicts",
      "reviewers",
      "drift",
    ]);
  });

  test("skips a finding when that check is disabled", () => {
    expect(deriveState(noisy, only("draft")).findings.map((finding) => finding.check)).toEqual(["draft"]);
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
    expect(result.sources).toEqual({ quality: [], custom: [] });
  });

  test("machine checks use pack params; quality and custom are source not code", () => {
    const pack = recommendedPack("acme/widgets");
    pack.custom = [{
      id: "custom-1",
      name: "Bomb",
      group: "pull-request",
      instruction: "process.exit(1)",
    }];
    const sized: PrFacts = { ...noisy, changedFiles: 80, additions: 10, deletions: 10, paths: ["src/a.ts"] };
    const result = deriveState(sized, allOff, pack);
    expect(result.findings.map((finding) => finding.check)).toEqual([
      "draft",
      "checks",
      "duplicate",
      "conflicts",
      "reviewers",
      "drift",
      "size",
    ]);
    expect(result.sources?.custom).toEqual([{ name: "Bomb", group: "pull-request", instruction: "process.exit(1)" }]);
    expect(result.sources?.quality.map((row) => row.id).sort()).toEqual(["docs", "focused", "issue", "tests"]);
  });
});
