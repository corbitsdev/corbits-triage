import { describe, expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY, emptyPack, isPatternsCheck, readCheckPack, readPolicyFile, recommendedPack, repoPolicy, type RepoPolicy } from "@corbits/triage-contracts";
import { deriveState, REVIEW_ANSWERED_REASON, type PrFacts, type PrFileFacts } from "./checks.ts";
import { filesToRead, patternsResult } from "./patterns.ts";
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
      "linked-issue",
    ]);
    expect(result.checks.find((check) => check.check === "no-changes-requested")).toMatchObject({
      result: "fail",
      evidence: ["changes requested by @maintainer"],
    });
    expect(result.labelled?.checks.find((check) => check.check === "max-files-changed")).toEqual({
      check: "max-files-changed",
      kind: "machine",
      result: "fail",
      reason: "pull request is over the files limit",
      evidence: ["80 files (max 30)"],
      output: { kind: "values", values: { files: 80 } },
    });
    expect(result.labelled?.checks.find((check) => check.check === "max-lines-changed")).toMatchObject({ result: "pass", evidence: ["20 lines changed (max 3000)"] });
    expect(result.checks.find((check) => check.check === "no-forbidden-paths")?.result).toBe("pass");
    expect(result.sources?.custom).toEqual(pack.custom);
    expect(result.sources?.quality.map((row) => row.id).sort()).toEqual(["docs", "focused"]);
  });

  test("size rules leave generated files out of every count, and the per-file rule names the files over it", () => {
    const pack = emptyPack("acme/widgets");
    pack.checks = {
      "max-files-changed": { enabled: true, maxFiles: 1 },
      "max-lines-changed": { enabled: true, maxLines: 30 },
      "max-lines-changed-per-file": { enabled: true, maxFileLines: 10 },
      "max-additions": { enabled: true, maxAdditions: 20 },
      "max-deletions": { enabled: true, maxDeletions: 5 },
    };
    const files = [{ path: "bun.lock", additions: 900, deletions: 900 }, { path: "src/a.ts", additions: 20, deletions: 0 }, { path: "src/b.ts", additions: 4, deletions: 6 }];
    const facts: PrFacts = { ...noisy, changedFiles: 3, additions: 924, deletions: 906, files, paths: files.map((file) => file.path) };
    const checks = Object.fromEntries(deriveState(facts, undefined, pack).checks.map((check) => [check.check, [check.result, check.evidence]]));
    expect(checks).toMatchObject({
      "max-files-changed": ["fail", ["2 files (max 1)"]],
      "max-lines-changed": ["pass", ["30 lines changed (max 30)"]],
      "max-additions": ["fail", ["24 lines added (max 20)"]],
      "max-deletions": ["fail", ["6 lines deleted (max 5)"]],
      "max-lines-changed-per-file": ["fail", ["src/a.ts: 20 lines changed (max 10)"]],
    });
  });
});

describe("deriveState check output", () => {
  test("each fact is named for what it states, so pending CI never reads as passing", () => {
    const pack = recommendedPack("acme/widgets");
    pack.checks["no-forbidden-paths"] = { enabled: true, forbiddenGlobs: ["vendor/**"] };
    const facts: PrFacts = { ...noisy, checks: "pending", mergeable: true, paths: ["vendor/x.ts"], changedFiles: 1, additions: 1, deletions: 0 };
    const result = deriveState(facts, undefined, pack);
    const outputs = Object.fromEntries([...result.checks, ...result.labelled!.checks].map((check) => [check.check, check.output]));
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

describe("code patterns", () => {
  const open: PrFacts = { ...noisy, draft: false, mergeable: true, checks: "success" };
  const content = "const a = x ?? 0;\nconst b = y ?? 0;\nconst c = p ? 1 : q ? 2 : 3;\nconst d = (n ?? 0) + 1;\n";
  const patch = "@@ -1,2 +1,4 @@\n const a = x ?? 0;\n-const b = 1;\n+const b = y ?? 0;\n+const c = p ? 1 : q ? 2 : 3;\n+const d = (n ?? 0) + 1;\n";
  const file = { path: "src/a.ts", status: "modified", additions: 3, deletions: 1, patch };
  const FILE = `onFail: ask
rules:
  - id: conventions
    check: code-patterns
    text: Follow our conventions.
    reason: Review time.
    evidence: [maintainer-stated]
    presets: [convention]
  - id: no-ternaries
    check: code-patterns
    text: No nested ternaries.
    reason: Readability.
    evidence: [maintainer-stated]
    onFail: fail
    presets: [convention]
    patterns:
      - id: nested-ternary
        language: typescript
        message: Our own nested ternary rule.
        rule: { kind: ternary_expression, has: { field: alternative, kind: ternary_expression } }
`;

  function patterns(files: PrFileFacts[], contents: Record<string, string>, pack = readCheckPack(readPolicyFile(FILE, "acme/widgets"))) {
    const matched = Object.fromEntries(pack.custom.filter(isPatternsCheck).map((rule) => [rule.id, patternsResult(rule, files, contents)]));
    return deriveState({ ...open, files, patterns: matched }, undefined, pack);
  }

  test("matches on added lines only, never a counter's default, and a rule's own pattern wins over the preset's on a shared id", () => {
    const result = patterns([file], { "src/a.ts": content });
    const fallback = "src/a.ts:2 Invented fallback `?? 0`; handle the missing value instead.";
    expect(result.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "fail", onFail: "ask", evidence: [fallback, "src/a.ts:3 Nested ternary; use if statements or a lookup."] });
    expect(result.checks.find((check) => check.check === "no-ternaries")).toMatchObject({ result: "fail", evidence: [fallback, "src/a.ts:3 Our own nested ternary rule."] });
    expect(result.checks.find((check) => check.check === "no-ternaries")?.onFail).toBeUndefined();
  });

  test("the preset checks JavaScript as TypeScript, and a rule's own pattern replaces the preset's id in both", () => {
    for (const path of ["src/a.js", "src/a.mjs", "src/a.jsx"]) {
      const result = patterns([{ ...file, path }], { [path]: content });
      const fallback = `${path}:2 Invented fallback \`?? 0\`; handle the missing value instead.`;
      expect(result.checks.find((check) => check.check === "conventions")?.evidence).toEqual([fallback, `${path}:3 Nested ternary; use if statements or a lookup.`]);
      expect(result.checks.find((check) => check.check === "no-ternaries")?.evidence).toEqual([fallback]);
    }
  });

  test("only root vendored and built code is skipped, and named as skipped; the same folders nested are checked", () => {
    const skipped = ["vendor/lib/a.ts: skipped as vendored, built or installed code", "dist/a.js: skipped as vendored, built or installed code"];
    const rootOnly = patterns([{ ...file, path: "vendor/lib/a.ts" }, { ...file, path: "dist/a.js" }], {});
    expect(rootOnly.checks.find((check) => check.check === "conventions")).toMatchObject({
      result: "pass",
      reason: "nothing checked: every changed file is vendored, built or installed code",
      evidence: skipped,
      skipped,
    });
    for (const path of ["src/build/a.ts", "scripts/build/deploy.ts", "src/vendor/a.ts", "apps/web/src/generated/x.ts"]) {
      const nested = patterns([{ ...file, path }], { [path]: content });
      expect(nested.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "fail" });
    }
  });

  test("a rule's files and ignores scope it as in ast-grep; the shipped fallbacks ignore test files", () => {
    for (const testPath of ["src/a.test.ts", "src/a.test.js"]) {
      const inTest = patterns([{ ...file, path: testPath }], { [testPath]: content });
      expect(inTest.checks.find((check) => check.check === "conventions")?.evidence).toEqual([`${testPath}:3 Nested ternary; use if statements or a lookup.`]);
    }
    function scoped(scope: string) {
      return readPolicyFile(`rules:
  - id: no-ternaries
    check: code-patterns
    text: No nested ternaries.
    reason: Readability.
    evidence: [maintainer-stated]
    patterns:
      - id: nested-ternary
        language: typescript
        message: Our own nested ternary rule.
        ${scope}
        rule: { kind: ternary_expression, has: { field: alternative, kind: ternary_expression } }
`, "acme/widgets");
    }
    function result(scope: string, path: string) {
      return patterns([{ ...file, path }], { [path]: content }, readCheckPack(scoped(scope))).checks.find((check) => check.check === "no-ternaries")?.result;
    }
    expect(result('files: ["src/*.ts"]', "src/deep/a.ts")).toBe("fail");
    expect(result('files: ["src/*.ts"]', "lib/a.ts")).toBe("pass");
    expect(result('ignores: ["*.test.ts"]', "src/a.test.ts")).toBe("pass");
    expect(result('ignores: ["*.test.ts"]', "src/a.ts")).toBe("fail");
    expect(() => scoped('ignores: ["src/[a"]')).toThrow('"src/[a"');
    expect(() => scoped('ignores: ["src/[!a].ts"]')).toThrow('"src/[!a].ts": write a negated class as [^…]');
  });

  test("a file without its patch, as on Bitbucket Data Center, an unread content or a broken rule never passes", () => {
    const unpatched = { path: "src/a.ts", status: "modified", additions: 0, deletions: 0 };
    expect(filesToRead([unpatched])).toEqual({ unread: "src/a.ts: its patch was not read in full" });
    expect(patterns([unpatched], {}).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed", output: { kind: "could-not-check" } });
    expect(patterns([file], {}).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    const nested = patterns([{ ...file, path: "src/build/a.ts" }], {});
    expect(nested.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    expect(deriveState({ ...open, files: [file] }, undefined, readCheckPack(readPolicyFile(FILE, "acme/widgets"))).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    const broken = readCheckPack({ ...emptyPack("acme/widgets"), custom: [{ id: "broken", name: "Broken", group: "pull-request", kind: "code-patterns", presets: [], patterns: [{ id: "bad", language: "typescript", message: "Bad.", rule: { kind: "no_such_kind" } }] }] });
    expect(patterns([file], { "src/a.ts": content }, broken).checks.find((check) => check.check === "broken")).toMatchObject({ result: "unconfirmed" });
  });

  test("an unknown preset is refused", () => {
    expect(() => readPolicyFile(FILE.replace("[convention]", "[nope]"), "acme/widgets")).toThrow();
  });
});

describe("conventional commits", () => {
  const open: PrFacts = { ...noisy, draft: false, mergeable: true, checks: "success" };
  const RULE = "rules:\n  - check: conventional-commits\n    text: Conventional.\n    reason: History.\n    evidence: [maintainer-stated]\n";

  function conventional(title: string, commitMessages: string[], settings = "") {
    const pack = readCheckPack(readPolicyFile(`${RULE}${settings}`, "acme/widgets"));
    return deriveState({ ...open, title, commitMessages }, undefined, pack).checks.find((check) => check.check === "conventional-commits");
  }

  test("a type in any case, a scope and a breaking mark pass, and merges and reverts are skipped", () => {
    expect(conventional("feat(api)!: drop v1", ["Fix: login\n\nBody", "Merge pull request #4 from acme/fix", "Merge pull request #12 in PROJ/widgets from fix to main", "Merge branch 'main' into fix", 'Revert "feat: login"', "chore(deps): bump"])).toMatchObject({ result: "pass", reason: "follows conventional commits" });
  });

  test("an unknown type, a missing colon or space, and a type the policy leaves out each fail, named", () => {
    expect(conventional("feature: login", ["fix login", "fix:login", "fix(): login"])).toMatchObject({
      result: "fail",
      reason: "`feature: login` isn't a conventional commit; `fix login` isn't a conventional commit; `fix:login` isn't a conventional commit; and 1 more",
    });
    expect(conventional("feat: login", [], "    types: [fix]\n")).toMatchObject({ result: "fail", reason: "`feat: login` isn't a conventional commit" });
  });

  test("title-only reads no commits", () => {
    expect(conventional("fix: login", ["Add tests"], "    fields: [title]\n")).toMatchObject({ result: "pass" });
  });
});

test("a v4 policy file runs only its rules, as the extension runs it", () => {
  const rules = "rules:\n  - check: ci-green\n    text: CI passes.\n    reason: Required.\n    evidence: [maintainer-stated]\n";
  const blocks = "code-review: { on: true }\nsecurity: { on: true, when: { triage: pass } }\ndecide:\n  - { if: { all: clean }, do: approve }\n";
  const v4 = deriveState(noisy, undefined, readCheckPack(readPolicyFile(`${rules}${blocks}`, "acme/widgets")));
  expect(v4).toEqual(deriveState(noisy, undefined, readCheckPack(readPolicyFile(rules, "acme/widgets"))));
  expect(v4.findings.map((finding) => finding.check)).toEqual(["ci-green"]);
});
