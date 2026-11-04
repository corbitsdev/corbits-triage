import { describe, expect, test } from "bun:test";
import { emptyPack, isPatternsCheck, readCheckPack, readPolicyFile } from "@corbits/triage-contracts";
import { deriveState, type PrFacts, type PrFileFacts } from "./checks.ts";
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

describe("size rules", () => {
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

describe("sensitive paths and risk", () => {
  const open: PrFacts = { ...noisy, draft: false, mergeable: true, checks: "success", fixes: {} };
  const pack = readCheckPack({ ...emptyPack("acme/widgets"), checks: { "sensitive-paths": { enabled: true, onFail: "ask" }, risk: { enabled: true, onFail: "ask" } } });

  function changed(paths: string[], facts: Partial<PrFacts> = {}): PrFacts {
    return { ...open, changedFiles: paths.length, files: paths.map((path) => ({ path, additions: 1, deletions: 0 })), paths, additions: paths.length, ...facts };
  }

  const riskOnly = readCheckPack({ ...emptyPack("acme/widgets"), checks: { risk: { enabled: true, onFail: "ask" } } });

  function rule(facts: PrFacts, id: string, policy = pack) {
    return deriveState(facts, undefined, policy).checks.find((check) => check.check === id);
  }

  test("sensitive paths asks a maintainer about a high group, labels a medium one, names each group's files up to five, and reads the policy's own groups", () => {
    expect(rule(changed(["db/migrations/0001.sql", "bun.lock", "src/a.ts"]), "sensitive-paths")).toMatchObject({ result: "fail", onFail: "ask", reason: "changes sensitive paths", evidence: ["schema: db/migrations/0001.sql", "locks: bun.lock"] });
    expect(rule(changed(["bun.lock", ".github/workflows/ci.yml"]), "sensitive-paths")).toMatchObject({ result: "pass", label: "sensitive: medium", evidence: ["ci: .github/workflows/ci.yml", "locks: bun.lock"] });
    expect(rule(changed(["src/a.ts", "README.md"]), "sensitive-paths")).toMatchObject({ result: "pass", evidence: [] });
    const own = readCheckPack({ ...pack, checks: { "sensitive-paths": { enabled: true, onFail: "ask", sensitiveGroups: { infra: { level: "high", paths: ["infra/**"] } } } } });
    const infra = Array.from({ length: 7 }, (_, at) => `infra/${at}.tf`);
    expect(rule(changed([...infra, "db/migrations/0001.sql"]), "sensitive-paths", own)?.evidence).toEqual([...infra.slice(0, 5).map((path) => `infra: ${path}`), "and 2 more"]);
  });

  test.each([
    ["no signal is low", changed(["src/a.ts", "src/a.test.ts"]), "pass", "low", []],
    ["source without tests is medium", changed(["src/a.ts"]), "pass", "medium", ["no tests"]],
    ["a first-time contributor is medium", changed(["src/a.ts", "src/a.test.ts"], { authorKind: "FIRST_TIME_CONTRIBUTOR" }), "pass", "medium", ["first-time contributor"]],
    ["a recently fixed file is medium", changed(["src/a.ts", "src/a.test.ts"], { fixes: { "src/a.ts": 4 } }), "pass", "medium", ["1 recently fixed file"]],
    ["a size limit alone is medium", changed(["src/a.ts", "src/a.test.ts"], { additions: 3001 }), "pass", "medium", ["3001 lines"]],
    ["a high sensitive group is high", changed(["db/schema.sql", "src/a.test.ts"]), "fail", "high", ["schema paths"]],
    ["a medium sensitive group is medium", changed(["bun.lock", "src/a.ts", "src/a.test.ts"]), "pass", "medium", ["locks paths"]],
    ["a medium sensitive group and another signal stay medium", changed(["bun.lock", "src/a.ts"]), "pass", "medium", ["locks paths", "no tests"]],
    ["a size limit with no tests is high", changed(Array.from({ length: 42 }, (_, at) => `src/${at}.ts`)), "fail", "high", ["42 files", "no tests"]],
    ["changed translations are not source", changed(["locales/en.json"]), "pass", "low", []],
    ["changed reStructuredText docs are not source", changed(["docs/index.rst", "LICENSE"]), "pass", "low", []],
    ["a CI-only change is its group's level and needs no tests", changed([".github/workflows/ci.yml"]), "pass", "medium", ["ci paths"]],
    ["end-to-end tests count as tests", changed(["src/login.ts", "e2e/login.ts"]), "pass", "low", []],
    ["Cypress tests and snapshots count as tests", changed(["app/login.py", "cypress/login.cy.js", "__snapshots__/login.snap"]), "pass", "low", []],
    ["type declarations, docs and examples are not source", changed(["types/index.d.ts", "docs/guide.ts", "examples/demo.py"]), "pass", "low", []],
    ["Go source without tests is medium", changed(["cmd/main.go", "config.yaml"]), "pass", "medium", ["no tests"]],
  ])("%s", (_, facts, result, level, evidence) => {
    expect(rule(facts, "risk", riskOnly)).toMatchObject({ result, evidence, output: { values: { level } } });
  });

  test("with sensitive paths on, a high group is asked about once, by that rule", () => {
    const migration = changed(["db/migrations/0001.sql", "src/a.test.ts"]);
    expect(rule(migration, "sensitive-paths")).toMatchObject({ result: "fail", onFail: "ask" });
    expect(rule(migration, "risk")).toMatchObject({ result: "pass", evidence: [], output: { values: { level: "low" } } });
    expect(rule(changed(["bun.lock", "src/a.test.ts"]), "risk")).toMatchObject({ result: "pass", evidence: ["locks paths"], label: "risk: medium" });
  });

  test("risk labels at its labelAt level below failAt, and the policy's thresholds move both", () => {
    expect(rule(changed(["src/a.ts"]), "risk")?.label).toBe("risk: medium");
    expect(rule(changed(["src/a.ts", "src/a.test.ts"]), "risk")?.label).toBeUndefined();
    const strict = readCheckPack({ ...pack, checks: { risk: { enabled: true, onFail: "ask", medium: 2, high: ["first-time"], failAt: "medium" } } });
    expect(rule(changed(["src/a.ts"]), "risk", strict)).toMatchObject({ result: "pass", output: { values: { level: "low" } } });
    expect(rule(changed(["src/a.ts"], { fixes: { "src/a.ts": 9 } }), "risk", strict)).toMatchObject({ result: "fail", reason: "risk is medium" });
    expect(rule(changed(["src/a.ts", "src/a.test.ts"], { authorKind: "FIRST_TIME_CONTRIBUTOR" }), "risk", strict)).toMatchObject({ result: "fail", reason: "risk is high" });
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

  const hiding = { ...open, body: "Adds login.", rawBody: "Adds login.\n<!-- Co-Authored-By: Bot -->\n[session](https://claude.ai/code/session_1)" };

  function textCheck(fields: string[], failWhen: string, phrases: string[], facts = open) {
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), custom: [{ id: "words", name: "Words", group: "pull-request", kind: "text", fields, failWhen, phrases }] });
    return deriveState(facts, undefined, pack).checks.find((check) => check.check === "words");
  }

  test("the title contains, case-insensitively", () => {
    expect(textCheck(["title"], "contains", ["FEAT:"])).toMatchObject({ kind: "machine", result: "fail", evidence: ["title: feat: Add login"] });
  });

  test("the title does not contain", () => {
    expect(textCheck(["title"], "not-contains", ["fix:", "chore:"])).toMatchObject({ result: "fail", reason: 'the title does not contain "fix:", "chore:"', evidence: ["title"] });
  });

  test("the description contains, quoting the line", () => {
    expect(textCheck(["description"], "contains", ["generated with"])).toMatchObject({ result: "fail", reason: 'the description contains "generated with"; remove it', evidence: ["description: Generated with a tool"] });
  });

  test("the description contains what its markup hides, quoting the line", () => {
    expect(textCheck(["description"], "contains", ["co-authored-by"], hiding)).toMatchObject({ result: "fail", evidence: ["description: <!-- Co-Authored-By: Bot -->"] });
    expect(textCheck(["description"], "contains", ["claude.ai"], hiding)).toMatchObject({ result: "fail", evidence: ["description: [session](https://claude.ai/code/session_1)"] });
  });

  test("the description does not contain reads only what a reader sees", () => {
    expect(textCheck(["description"], "not-contains", ["co-authored-by"], hiding)).toMatchObject({ result: "fail", evidence: ["description"] });
  });

  test("any commit message contains, past its subject", () => {
    expect(textCheck(["commits"], "contains", ["co-authored-by:"])).toMatchObject({ result: "fail", reason: 'a commit message contains "co-authored-by:"; remove it', evidence: ['commit "feat: add login": Co-Authored-By: Bot <bot@example.com>'] });
  });

  test("any commit message does not contain", () => {
    expect(textCheck(["commits"], "not-contains", ["login"])).toMatchObject({ result: "pass" });
    expect(textCheck(["commits"], "not-contains", ["feat"])).toMatchObject({ result: "fail", evidence: ['commit "docs: login"'] });
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
    const matched = Object.fromEntries(pack.custom.filter(isPatternsCheck).map((rule) => [rule.id, patternsResult(rule, files, contents, "github")]));
    return deriveState({ ...open, files, patterns: matched }, undefined, pack);
  }

  test("matches on added lines only, never a counter's default, and a rule's own pattern wins over the preset's on a shared id", () => {
    const result = patterns([file], { "src/a.ts": content });
    const fallback = "src/a.ts:2 zero-fallback: Invented fallback `?? 0`; handle the missing value instead.";
    expect(result.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "fail", onFail: "ask", evidence: [fallback, "src/a.ts:3 nested-ternary: Nested ternary; use if statements or a lookup."] });
    expect(result.checks.find((check) => check.check === "no-ternaries")).toMatchObject({ result: "fail", evidence: [fallback, "src/a.ts:3 nested-ternary: Our own nested ternary rule."] });
    expect(result.checks.find((check) => check.check === "no-ternaries")?.onFail).toBeUndefined();
  });

  test("the preset checks JavaScript as TypeScript, and a rule's own pattern replaces the preset's id in both", () => {
    for (const path of ["src/a.js", "src/a.mjs", "src/a.jsx"]) {
      const result = patterns([{ ...file, path }], { [path]: content });
      const fallback = `${path}:2 zero-fallback: Invented fallback \`?? 0\`; handle the missing value instead.`;
      expect(result.checks.find((check) => check.check === "conventions")?.evidence).toEqual([fallback, `${path}:3 nested-ternary: Nested ternary; use if statements or a lookup.`]);
      expect(result.checks.find((check) => check.check === "no-ternaries")?.evidence).toEqual([fallback]);
    }
  });

  test("a pull request that adds no TypeScript or JavaScript passes and says nothing was checked", () => {
    const result = patterns([{ ...file, path: "src/old.ts", status: "removed" }, { ...file, path: "cmd/main.go" }], {});
    expect(result.checks.find((check) => check.check === "conventions")).toMatchObject({
      result: "pass",
      reason: "nothing checked: no TypeScript or JavaScript code added",
      evidence: [],
    });
  });

  test("only root vendored and built code is skipped, and named as skipped; the same folders nested are checked", () => {
    const skipped = ["vendor/lib/a.ts: skipped as vendored, built or installed code", "dist/a.js: skipped as vendored, built or installed code"];
    const rootOnly = patterns([{ ...file, path: "vendor/lib/a.ts" }, { ...file, path: "dist/a.js" }], {});
    expect(rootOnly.checks.find((check) => check.check === "conventions")).toMatchObject({
      result: "pass",
      reason: "nothing checked: the only TypeScript or JavaScript changed is vendored, built or installed code",
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
      expect(inTest.checks.find((check) => check.check === "conventions")?.evidence).toEqual([`${testPath}:3 nested-ternary: Nested ternary; use if statements or a lookup.`]);
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
    const unpatched = { path: "src/a.ts", status: "modified", additions: 3, deletions: 0 };
    expect(filesToRead([unpatched], "github")).toEqual({ unread: "src/a.ts: the host sent no diff" });
    const past = (path: string) => ({ ...unpatched, path, patchUnread: true as const });
    expect(filesToRead([unpatched, past("src/b.ts"), past("src/c.ts")], "github")).toEqual({ unread: "src/a.ts: the host sent no diff; src/b.ts and 1 more: the pull request's diff is larger than Triage reads" });
    expect(patterns([unpatched], {}).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed", output: { kind: "could-not-check" } });
    expect(patterns([file], {}).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    const nested = patterns([{ ...file, path: "src/build/a.ts" }], {});
    expect(nested.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    expect(deriveState({ ...open, files: [file] }, undefined, readCheckPack(readPolicyFile(FILE, "acme/widgets"))).checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed" });
    const broken = readCheckPack({ ...emptyPack("acme/widgets"), custom: [{ id: "broken", name: "Broken", group: "pull-request", kind: "code-patterns", presets: [], patterns: [{ id: "bad", language: "typescript", message: "Bad.", rule: { kind: "no_such_kind" } }] }] });
    expect(patterns([file], { "src/a.ts": content }, broken).checks.find((check) => check.check === "broken")).toMatchObject({ result: "unconfirmed" });
  });

  test("a match in a checked file fails, and without one a file that adds code the host sent no diff for leaves the rule unconfirmed", () => {
    const large = { path: "src/large.ts", status: "modified", additions: 9_000, deletions: 0 };
    const clean = { path: "src/b.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+const b = 1;" };
    const left = "src/large.ts: not checked, the host sent no diff";
    expect(filesToRead([file, large, clean], "github")).toEqual(["src/a.ts", "src/b.ts"]);
    const failed = patterns([file, large], { "src/a.ts": content });
    expect(failed.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "fail", evidence: expect.arrayContaining([left]), skipped: [left] });
    const unchecked = patterns([clean, large], { "src/b.ts": "const b = 1;\n" });
    expect(unchecked.checks.find((check) => check.check === "conventions")).toMatchObject({ result: "unconfirmed", reason: "code patterns could not be checked: src/large.ts: the host sent no diff" });
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
  const blocks = "code-review: { on: true, when: { triage: pass } }\ndecide:\n  - { if: { all: clean }, do: approve }\n";
  const v4 = deriveState(noisy, undefined, readCheckPack(readPolicyFile(`${rules}${blocks}`, "acme/widgets")));
  expect(v4).toEqual(deriveState(noisy, undefined, readCheckPack(readPolicyFile(rules, "acme/widgets"))));
  expect(v4.findings.map((finding) => finding.check)).toEqual(["ci-green"]);
});
