import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, readCheckPack, recommendedPack, repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { deriveState, REVIEW_ANSWERED_REASON, type PrFacts } from "./checks.ts";
import { NO_FACTS } from "./item.ts";

const noisy: PrFacts = {
  ...NO_FACTS,
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
  enabled: true,
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
      "ci-green",
      "no-merge-conflicts",
    ]);
  });

  test("skips a finding when that check is disabled; the draft check always runs", () => {
    const off = deriveState(noisy, allOff);
    expect(off.findings).toEqual([]);
    expect(off.checks).toEqual([{ check: "not-a-draft", kind: "machine", result: "fail", reason: "pull request is a draft", evidence: [], output: { kind: "values", values: { isDraft: true } } }, expect.objectContaining({ check: "no-changes-requested" })]);
    expect(deriveState(noisy, only("ci")).findings.map((finding) => finding.check)).toEqual(["ci-green"]);
    expect(deriveState(noisy, only("conflicts")).findings.map((finding) => finding.check)).toEqual(["no-merge-conflicts"]);
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
    expect(deriveState(unknown).findings.map((finding) => finding.check)).toEqual(["no-merge-conflicts"]);
    expect(deriveState(unknown).checks.find((check) => check.check === "no-merge-conflicts")?.output).toEqual({ kind: "could-not-check", reason: "mergeability not yet computed" });
    expect(deriveState(unknown, allOff).findings).toEqual([]);
  });
});

describe("deriveState check pack", () => {
  test("empty valid pack classifies with no catalog findings", () => {
    const result = deriveState(noisy, DEFAULT_REPO_POLICY, emptyPack("acme/widgets"));
    expect(result.findings).toEqual([]);
    expect(result.sources).toEqual({ quality: [], custom: [] });
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
      "ci-green",
      "no-merge-conflicts",
      "no-changes-requested",
      "max-files-changed",
      "linked-issue",
    ]);
    expect(result.checks.find((check) => check.check === "no-changes-requested")).toMatchObject({
      result: "fail",
      evidence: ["changes requested by @maintainer"],
    });
    expect(result.checks.find((check) => check.check === "max-files-changed")).toEqual({
      check: "max-files-changed",
      kind: "machine",
      result: "fail",
      reason: "pull request is over the files limit",
      evidence: ["80 files (max 30)"],
      output: { kind: "values", values: { files: 80 } },
    });
    expect(result.checks.find((check) => check.check === "max-lines-changed")).toMatchObject({ result: "pass", evidence: ["20 lines changed (max 3000)"] });
    expect(result.checks.find((check) => check.check === "no-forbidden-paths")?.result).toBe("pass");
    expect(result.sources?.custom).toEqual(pack.custom);
    expect(result.sources?.quality.map((row) => row.id).sort()).toEqual(["docs", "focused"]);
  });
});

describe("deriveState check output", () => {
  test("each fact is named for what it states, so pending CI never reads as passing", () => {
    const pack = recommendedPack("acme/widgets");
    pack.checks["no-forbidden-paths"] = { enabled: true, forbiddenGlobs: ["vendor/**"] };
    const facts: PrFacts = { ...noisy, checks: "pending", mergeable: true, paths: ["vendor/x.ts"], changedFiles: 1, additions: 1, deletions: 0 };
    const outputs = Object.fromEntries(deriveState(facts, undefined, pack).checks.map((check) => [check.check, check.output]));
    expect(outputs).toMatchObject({
      "not-a-draft": { kind: "values", values: { isDraft: true } },
      "ci-green": { kind: "could-not-check", reason: "checks are still running" },
      "no-merge-conflicts": { kind: "values", values: { hasConflicts: false } },
      "no-forbidden-paths": { kind: "values", values: { touchesForbiddenPaths: true } },
      "max-files-changed": { kind: "values", values: { files: 1 } },
      "max-lines-changed": { kind: "values", values: { lines: 1 } },
    });
  });
});

describe("review check", () => {
  test("keeps the author's turn on requested changes and waits on the reviewer once answered", () => {
    const requested = { ...noisy, changesRequested: ["maya"] };
    const review = (facts: PrFacts) => deriveState(facts, allOff).checks.find((check) => check.check === "no-changes-requested");
    expect(review(requested)).toMatchObject({ result: "fail", reason: "a reviewer requested changes" });
    expect(review({ ...requested, reviewAnswered: true })).toMatchObject({ result: "fail", reason: REVIEW_ANSWERED_REASON });
    expect(deriveState(requested, allOff).state).toBe("needs-author-update");
    expect(deriveState({ ...requested, reviewAnswered: true }, allOff).state).toBe("awaiting-review");
  });
});

describe("a policy stored with the old rule ids", () => {
  function stored(ids: Record<string, string>) {
    return {
      ...emptyPack("acme/widgets"),
      checks: {
        [ids.size!]: { enabled: true, maxFiles: 5, maxLines: 100 },
        [ids.issue!]: { enabled: true, tracker: "github" },
        [ids.conflicts!]: { enabled: true },
        [ids.ci!]: { enabled: true },
        [ids.paths!]: { enabled: true, forbiddenGlobs: ["vendor/**"] },
      },
    };
  }
  const OLD = { size: "size", issue: "issue", conflicts: "conflicts", ci: "ci", paths: "paths" };
  const NEW = { size: "max-files-changed", issue: "linked-issue", conflicts: "no-merge-conflicts", ci: "ci-green", paths: "no-forbidden-paths" };

  test("loads and evaluates as the same policy written with the new ids", () => {
    const old = readCheckPack(JSON.stringify(stored(OLD)));
    const current = readCheckPack({ ...stored(NEW), checks: { ...stored(NEW).checks, "max-files-changed": { enabled: true, maxFiles: 5 }, "max-lines-changed": { enabled: true, maxLines: 100 } } });
    expect(old).toEqual(current);
    const facts: PrFacts = { ...noisy, draft: false, mergeable: true, checks: "success", changedFiles: 9, additions: 40, deletions: 0, paths: ["src/a.ts", "bun.lock"], body: "Fixes #12", events: ["opened"] };
    const ran = deriveState(facts, undefined, old);
    expect(ran).toEqual(deriveState(facts, undefined, current));
    expect(Object.fromEntries(ran.checks.map((check) => [check.check, check.result]))).toEqual({
      "not-a-draft": "pass", "ci-green": "pass", "no-changes-requested": "pass", "no-merge-conflicts": "pass", "max-files-changed": "fail", "max-lines-changed": "pass", "no-forbidden-paths": "pass", "linked-issue": "pass",
    });
  });
});

describe("text rules", () => {
  const open: PrFacts = { ...noisy, draft: false, mergeable: true, checks: "success", title: "feat: Add login", body: "Adds login.\nGenerated with a tool", commitMessages: ["feat: add login\n\nCo-Authored-By: Bot <bot@example.com>", "docs: login"] };

  function textCheck(fields: string[], failWhen: string, phrases: string[]) {
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), custom: [{ id: "words", name: "Words", group: "pull-request", kind: "text", fields, failWhen, phrases }] });
    return deriveState(open, undefined, pack).checks.find((check) => check.check === "words");
  }

  test("the title contains, case-insensitively", () => {
    expect(textCheck(["title"], "contains", ["FEAT:"])).toMatchObject({ kind: "machine", result: "fail", evidence: ["title: feat: Add login"] });
  });

  test("the title does not contain", () => {
    expect(textCheck(["title"], "not-contains", ["fix:", "chore:"])).toMatchObject({ result: "fail", evidence: ["title"] });
  });

  test("the description contains, quoting the line", () => {
    expect(textCheck(["description"], "contains", ["generated with"])).toMatchObject({ result: "fail", reason: 'the description contains "generated with"', evidence: ["description: Generated with a tool"] });
  });

  test("the description does not contain", () => {
    expect(textCheck(["description"], "not-contains", ["Adds"])).toMatchObject({ result: "pass", evidence: [] });
  });

  test("any commit message contains, past its subject", () => {
    expect(textCheck(["commits"], "contains", ["co-authored-by:"])).toMatchObject({ result: "fail", reason: 'a commit message contains "co-authored-by:"', evidence: ['commit "feat: add login": Co-Authored-By: Bot <bot@example.com>'] });
  });

  test("any commit message does not contain", () => {
    expect(textCheck(["commits"], "not-contains", ["login"])).toMatchObject({ result: "pass" });
    expect(textCheck(["commits"], "not-contains", ["feat"])).toMatchObject({ result: "fail", evidence: ['commit "docs: login"'] });
  });

  test("a failed text rule fails the pull request without the decision model", () => {
    const result = deriveState(open, undefined, recommendedPack("acme/widgets"));
    expect(result.checks.find((check) => check.check === "no-attribution-trailers")?.result).toBe("fail");
    expect(result.needsJudgment).toBe(false);
  });
});
