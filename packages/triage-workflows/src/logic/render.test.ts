import { describe, expect, test } from "bun:test";
import { classificationSources, DEFAULT_MERGE_THRESHOLD, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict } from "./render.js";
import { QUALITY_EVALUATION_LIMIT_ERROR, type FocusedPlan, type QualityPlan } from "./quality.js";
import { REVIEW_ANSWERED_REASON, type DeterministicResult } from "./checks.js";

describe("custom check rendering", () => {
  test("a model row is asked by its stored id; a rule row is not a question", () => {
    const pack: CheckPack = {
      ...emptyPack("acme/widgets"),
      custom: [
        { id: "custom-1", name: "No vendor edits", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["vendor/**"] },
        { id: "custom-2", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "The title mentions a ticket id." },
      ],
    };
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: {
        state: "ready-monitoring",
        reason: "all deterministic checks passed",
        findings: [],
        checks: [],
        needsJudgment: true,
        sources: classificationSources(pack),
      },
      answers: { "custom-2": 0.1 },
      threshold: DEFAULT_MERGE_THRESHOLD,
    });

    expect(verdict.checks).toEqual([
      { check: "custom-2", kind: "model", result: "fail", reason: 'does not meet "Ticket"', evidence: [], output: { kind: "score", score: 10, passAt: 70, items: [] } },
    ]);
  });
});

const FOCUSED_SOURCES = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [], rules: [] };
const FOCUSED_DET: DeterministicResult = {
  state: "ready-monitoring",
  reason: "all configured checks pass",
  findings: [],
  checks: [],
  needsJudgment: true,
  sources: FOCUSED_SOURCES,
};

function focusedAnswer(one: number, more: number): string {
  const probabilities = { one_thing: one, more_than_one_thing: more, cant_tell: 1 - one - more };
  return JSON.stringify({ id: "focused", type: "choice", choice: one >= more ? "one_thing" : "more_than_one_thing", probabilities, confidence: 0.9 });
}

function sliceAnswer(id: string, serves: number, separate: number): string {
  const probabilities = { serves_purpose: serves, separate_change: separate, cant_tell: 1 - serves - separate };
  return JSON.stringify({ id, type: "choice", choice: serves >= separate ? "serves_purpose" : "separate_change", probabilities, confidence: 0.9 });
}

/** Focused asked of `slices`, with follow-up file questions, one per path in order, answered with how likely each file is a separate change. */
function focusedPlan(separate: Record<string, number>, slices: Record<string, string[]> = { focused: Object.keys(separate) }, unread: string[] = []): { focused: FocusedPlan; nouls: string } {
  const ids = Object.keys(separate).map((_, index) => `focused-file-${String(index + 1).padStart(3, "0")}`);
  const parts = Object.fromEntries(Object.keys(separate).map((path, index) => [ids[index]!, path]));
  const nouls = Object.values(separate).map((noul, index) => JSON.stringify({ id: ids[index], type: "noul", noul })).join("");
  return { focused: { slices, unread, parts }, nouls };
}

function focusedVerdict(reply: string, focused: FocusedPlan = focusedPlan({}).focused, threshold = DEFAULT_MERGE_THRESHOLD) {
  return renderVerdict({
    author: "octocat",
    repo: "acme/widgets",
    headSha: "abc123",
    det: FOCUSED_DET,
    answers: parseAnswers(reply),
    focused,
    threshold,
  });
}

const UNSURE_FOCUSED = "Not yet confirmed, a maintainer will check:\n- makes one focused change";
const OUTAGE_NOTE = "Some checks could not run this time. Triage will re-check this pull request.";
const APPROVAL_NOTE = "No changes needed from you. A maintainer will review this pull request.";

describe("focused rendering", () => {
  test("fails on more than one thing, naming at most three files most likely to be the separate change", () => {
    const { focused, nouls } = focusedPlan({ "src/a.ts": 0.1, "src/b.ts": 0.75, "src/c.ts": 0.9, "src/d.ts": 0.8, "src/e.ts": 0.71, "src/f.ts": 0.6 });
    const verdict = focusedVerdict(focusedAnswer(0.1, 0.85) + nouls, focused);
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, humanGated: false, score: 0.85 });
    expect(verdict.checks).toEqual([{
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["src/c.ts", "src/d.ts", "src/b.ts"],
      output: { kind: "score", score: expect.closeTo(10), passAt: 60, items: ["src/c.ts", "src/d.ts", "src/b.ts"] },
    }]);
    expect(verdict.reason).toBe("mixes unrelated changes: src/c.ts, src/d.ts, src/b.ts");
    expect(verdict.feedback.split("\n").slice(1)).toEqual([
      "- Split out unrelated change: `src/c.ts`",
      "- Split out unrelated change: `src/d.ts`",
      "- Split out unrelated change: `src/b.ts`",
    ]);
  });

  test("names a file split across failing slices once", () => {
    const focused: FocusedPlan = { slices: { "focused-slice-001": ["src/a.ts"], "focused-slice-002": ["src/a.ts"] }, unread: [], parts: { "focused-slice-001-file-001": "src/a.ts", "focused-slice-002-file-001": "src/a.ts" } };
    const nouls = Object.keys(focused.parts).map((id) => JSON.stringify({ id, type: "noul", noul: 0.9 })).join("");
    const verdict = focusedVerdict(sliceAnswer("focused-slice-001", 0.1, 0.8) + sliceAnswer("focused-slice-002", 0.1, 0.8) + nouls, focused);
    expect(verdict.checks[0]).toMatchObject({ result: "fail", evidence: ["src/a.ts"], output: { items: ["src/a.ts"] } });
  });

  test("still fails when no file is clearly the separate change", () => {
    const { focused, nouls } = focusedPlan({ "src/a.ts": 0.5 });
    const verdict = focusedVerdict(focusedAnswer(0.2, 0.8) + nouls, focused);
    expect(verdict.checks[0]).toMatchObject({ result: "fail", evidence: [], output: { kind: "score", items: [] } });
    expect(verdict.feedback.split("\n").slice(1)).toEqual(["- mixes unrelated changes"]);
    expect(verdict.nextAction).toBe("Split out unrelated changes");
  });

  test("passes on one thing only when every file was read, and a failure lists what it could not read", () => {
    const verdict = focusedVerdict(focusedAnswer(0.8, 0.1));
    expect(verdict).toMatchObject({ state: "ready-monitoring", mirror: true, humanGated: false, score: 0.8 });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "makes one focused change", evidence: [], output: { kind: "score", score: 80, passAt: 60, items: [] } }]);
    const unread = focusedPlan({}, { focused: [] }, ["src/big.ts"]).focused;
    expect(focusedVerdict(focusedAnswer(0.8, 0.1), unread).checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "not enough evidence to decide", evidence: [], output: { kind: "could-not-check", reason: "file could not be read", items: ["src/big.ts"] } }]);
    expect(focusedVerdict(focusedAnswer(0.1, 0.8), unread).checks[0]).toMatchObject({ result: "fail", output: { kind: "score", unread: ["src/big.ts"] } });
  });

  test("a diff in slices fails on any separate slice, passes when every slice serves, and scores the least serving one", () => {
    const { focused, nouls } = focusedPlan({ "src/b.ts": 0.9 }, { "focused-slice-001": ["src/a.ts"], "focused-slice-002": ["src/b.ts"] });
    function check(...answers: string[]) {
      return focusedVerdict(answers.join(""), focused).checks[0];
    }
    expect(check(sliceAnswer("focused-slice-001", 0.9, 0.05), sliceAnswer("focused-slice-002", 0.7, 0.2))).toMatchObject({ result: "pass", output: { kind: "score", score: 70 } });
    expect(check(sliceAnswer("focused-slice-001", 0.9, 0.05), sliceAnswer("focused-slice-002", 0.1, 0.8), nouls)).toMatchObject({ result: "fail", evidence: ["src/b.ts"], output: { kind: "score", score: expect.closeTo(10) } });
    expect(check(sliceAnswer("focused-slice-001", 0.9, 0.05), sliceAnswer("focused-slice-002", 0.5, 0.4))).toMatchObject({ result: "unconfirmed", output: { kind: "score", score: 50 } });
    expect(focusedVerdict(sliceAnswer("focused-slice-001", 0.9, 0.05), focused)).toMatchObject({ degraded: "inference-outage", checks: [{ result: "unconfirmed", reason: "decision model unavailable" }] });
  });

  test("does not apply with no lines to read", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, plan: {}, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "does not apply", evidence: [], output: { kind: "not-applicable" } }]);
    expect(verdict.degraded).toBeNull();
  });

  test("names an unsure focused check in the comment, awaits review and is red", () => {
    const verdict = focusedVerdict(focusedAnswer(0.5, 0.4));
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, merge: { verdict: "not-recommended" } });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "not enough evidence to decide", evidence: [], output: { kind: "score", score: 50, passAt: 60, items: [] } }]);
    expect(verdict.feedback).toBe(UNSURE_FOCUSED);
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: null, threshold: DEFAULT_MERGE_THRESHOLD, reasons: ["Not confirmed: makes one focused change"] });
  });

  test.each([
    ["missing", ""],
    ["malformed", JSON.stringify({ id: "focused", type: "choice", choice: "one_thing", probabilities: { one_thing: 1 }, confidence: 2 })],
  ] as const)("a %s answer is an outage that still posts", (_name, reply) => {
    const verdict = focusedVerdict(reply);
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: "inference-outage", feedback: OUTAGE_NOTE });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: null, threshold: DEFAULT_MERGE_THRESHOLD, reasons: ["Could not evaluate 1 check"] });
  });

  test("the judge budget and a judge outage both still post", () => {
    const limited = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, focused: focusedPlan({}, {}).focused, judgeError: QUALITY_EVALUATION_LIMIT_ERROR, judgeLimitExceeded: true, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(limited).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, feedback: UNSURE_FOCUSED });
    expect(limited.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: QUALITY_EVALUATION_LIMIT_ERROR, evidence: [], output: { kind: "could-not-check", reason: QUALITY_EVALUATION_LIMIT_ERROR } }]);
    expect(limited.reason).toBe(QUALITY_EVALUATION_LIMIT_ERROR);
    const outage = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, focused: focusedPlan({}).focused, judgeError: "upstream 503", threshold: DEFAULT_MERGE_THRESHOLD });
    expect(outage).toMatchObject({ mirror: true, humanGated: false, degraded: "inference-outage", feedback: OUTAGE_NOTE });
  });

  test("rejects duplicate decisions and illegal choice probability keys", () => {
    expect(focusedVerdict(focusedAnswer(0.8, 0.1) + focusedAnswer(0.8, 0.1))).toMatchObject({ degraded: "inference-outage" });
    const illegal = JSON.stringify({ id: "focused", type: "choice", choice: "one_thing", probabilities: { one_thing: 0.9, other: 0.1 }, confidence: 0.9 });
    expect(focusedVerdict(illegal)).toMatchObject({ degraded: "inference-outage" });
  });

  test("strictly validates noul decisions and decides them only outside the unsure band", () => {
    const det: DeterministicResult = {
      ...FOCUSED_DET,
      sources: {
        quality: [{ id: "tests", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const plan: QualityPlan = { tests: { changed: [], asked: { "tests-file-001": "src/a.ts" }, unread: [] } };
    function results(tests: number, custom: number) {
      const answers = noul({ "tests-file-001": tests, "custom-1": custom });
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks.map(({ check, result, evidence }) => [check, result, evidence]);
    }
    expect(results(0.9, 0.2)).toEqual([["tests", "fail", ["src/a.ts"]], ["custom-1", "fail", []]]);
    expect(results(0.5, 0.5)).toEqual([["tests", "unconfirmed", []], ["custom-1", "unconfirmed", []]]);
    expect(results(0.2, 0.9)).toEqual([["tests", "pass", []], ["custom-1", "pass", []]]);

    const duplicate = parseAnswers('{"id":"custom-1","type":"noul","noul":0.9}{"id":"custom-1","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: duplicate, plan, threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
    const unknown = parseAnswers('{"id":"tests","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: unknown, plan, threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
  });

  test("a model check scores how likely it is fine, unsure answers included, and a file it could not read is a state", () => {
    const det: DeterministicResult = {
      ...FOCUSED_DET,
      sources: {
        quality: [{ id: "tests", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const asked = { "tests-file-001": "src/a.ts", "tests-file-002": "src/b.ts" };
    function outputs(unread: string[]) {
      const plan: QualityPlan = { tests: { changed: [], asked, unread } };
      const answers = noul({ "tests-file-001": 0.2, "tests-file-002": 0.41, "custom-1": 0.55 });
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks.map(({ result, output }) => [result, output]);
    }
    expect(outputs([])).toEqual([
      ["unconfirmed", { kind: "score", score: expect.closeTo(59), passAt: 70, items: ["src/b.ts"] }],
      ["unconfirmed", { kind: "score", score: expect.closeTo(55), passAt: 70, items: [] }],
    ]);
    expect(outputs(["src/c.ts"])[0]).toEqual(["unconfirmed", { kind: "could-not-check", reason: "file could not be read", items: ["src/c.ts"] }]);
  });

  test("a score clears its bar exactly when the check passes, at every band edge", () => {
    const det: DeterministicResult = {
      ...FOCUSED_DET,
      sources: {
        quality: [{ id: "tests", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const plan: QualityPlan = { tests: { changed: [], asked: { "tests-file-001": "src/a.ts" }, unread: [] } };
    function modelChecks(answer: number) {
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul({ "tests-file-001": answer, "custom-1": answer }), plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks;
    }
    function focusedCheck(one: number) {
      return focusedVerdict(focusedAnswer(one, 0.2)).checks;
    }
    const checks = [0.3, 0.305, 0.695, 0.7].flatMap(modelChecks).concat([0.595, 0.6].flatMap(focusedCheck));
    for (const check of checks) {
      if (check.output.kind !== "score") throw new Error(`${check.check} has no score`);
      expect([check.check, check.output.score >= check.output.passAt]).toEqual([check.check, check.result === "pass"]);
    }
    expect(checks.map((check) => check.result)).toContain("pass");
  });

  test("an over-long comment is cut at line boundaries and still posts", () => {
    const custom = Array.from({ length: 200 }, (_, index) => ({ id: `custom-${index + 1}`, name: `${"N".repeat(500)}-${index}`, group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }));
    const det: DeterministicResult = { ...FOCUSED_DET, sources: { quality: [], custom, rules: [] } };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul(Object.fromEntries(custom.map((row) => [row.id, 0.1]))), threshold: DEFAULT_MERGE_THRESHOLD });
    const lines = verdict.feedback.split("\n").slice(1);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeLessThanOrEqual(MAX_MIRROR_COMMENT_BYTES);
    expect(lines[0]).toContain(custom[0]!.name);
    expect(lines.at(-1)).toBe(`- and ${200 - (lines.length - 1)} more`);
    expect(lines.length).toBeGreaterThan(50);
    expect(verdict).toMatchObject({ mirror: true, humanGated: false, actor: "author" });
  });

  test("an over-long CI name is cut to one line without replacing its CI and path verdict", () => {
    const checks = [
      { check: "ci", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: ["界".repeat(21_000)] },
      { check: "paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/generated.ts"] },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, needsJudgment: false },
      threshold: DEFAULT_MERGE_THRESHOLD,
    });
    expect(verdict.feedback).toBe(`@octocat, please address the following:\n- required checks are failing: \`${"界".repeat(200)}…\`\n- touches forbidden paths: \`vendor/generated.ts\``);
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", mirror: true, humanGated: false, checks });
    expect(verdict.nextAction).toContain("Fix failing CI");
    expect(verdict.nextAction).toContain("Remove changes under vendor/generated.ts");
  });
});

const MODEL_DET: DeterministicResult = {
  ...FOCUSED_DET,
  sources: { quality: [{ id: "docs", group: "code-vs-ci" }, { id: "tests", group: "code-vs-ci" }], custom: [], rules: [] },
};
const PLAN: QualityPlan = { docs: { changed: [], asked: { "docs-file-001": "src/a.ts" }, unread: [] }, tests: { changed: [], asked: { "tests-file-001": "src/a.ts" }, unread: [] } };

function noul(answers: Record<string, number>) {
  return parseAnswers(Object.entries(answers).map(([id, value]) => JSON.stringify({ id, type: "noul", noul: value })).join(""));
}

describe("merge verdict", () => {
  test("every check passing at or above the threshold is ready", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: MODEL_DET, answers: noul({ "docs-file-001": 0.1, "tests-file-001": 0.2 }), plan: PLAN, threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "ready", score: 0.8, threshold: 0.7, reasons: [] });
    expect(verdict).toMatchObject({ state: "ready-monitoring", mirror: true, feedback: APPROVAL_NOTE });
  });

  test("every check passing below the threshold is red with the score reason", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: MODEL_DET, answers: noul({ "docs-file-001": 0.1, "tests-file-001": 0.2 }), plan: PLAN, threshold: 0.85 });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.8, threshold: 0.85, reasons: ["Score 0.8 is below the threshold 0.85"] });
    expect(verdict.feedback).toBe(APPROVAL_NOTE);
  });

  test("a failing rule is red", () => {
    const checks = [{ check: "paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/a.ts"] }];
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...MODEL_DET, state: "blocked", checks }, answers: noul({ "docs-file-001": 0.1, "tests-file-001": 0.1 }), plan: PLAN, threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.9, threshold: 0.7, reasons: ["Failed: touches forbidden paths"] });
  });

  test("a failed chunk is red with the count of checks it could not evaluate and keeps the answered ones", () => {
    const det: DeterministicResult = { ...MODEL_DET, sources: { ...MODEL_DET.sources!, custom: [{ id: "custom-1", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "Names a ticket." }] } };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul({ "docs-file-001": 0.8 }), plan: PLAN, judgeError: "upstream 503", threshold: 0.7 });
    expect(verdict.checks.map(({ check, result }) => [check, result])).toEqual([["docs", "fail"], ["tests", "unconfirmed"], ["custom-1", "unconfirmed"]]);
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, degraded: "inference-outage" });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.8, threshold: 0.7, reasons: ["Could not evaluate 2 checks", "Failed: documentation is not updated"] });
    expect(verdict.feedback).toBe(`@octocat, please address the following:\n- documentation is not updated for \`src/a.ts\`\n\n${OUTAGE_NOTE}`);
  });

  test("rules only has no score and is green", () => {
    const checks = [{ check: "ci", kind: "machine" as const, result: "pass" as const, reason: "required checks pass", evidence: [] }];
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...FOCUSED_DET, checks, needsJudgment: false, sources: undefined }, threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "ready", score: null, threshold: 0.7, reasons: [] });
    expect(verdict).toMatchObject({ score: null, confidence: "unknown", mirror: true, feedback: APPROVAL_NOTE });
  });

  test("a closed pull request gets no comment", () => {
    const findings = [{ check: "state", state: "ready-monitoring" as const, reason: "pull request is closed" }];
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...MODEL_DET, findings, checks: [], needsJudgment: false }, threshold: 0.7 });
    expect(verdict).toMatchObject({ mirror: true, feedback: "" });
  });
});

describe("rule custom check rendering", () => {
  const rules = [
    { id: "custom-1", name: "Branch naming", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" },
    { id: "custom-2", name: "Two approvals", group: "around", kind: "rule", rule: "min-approvals", count: 2 },
  ] as const;
  const det: DeterministicResult = {
    state: "needs-author-update",
    reason: "Branch naming: branch does not match the pattern",
    findings: [{ check: "custom-1", state: "needs-author-update", reason: "Branch naming: branch does not match the pattern" }],
    checks: [
      { check: "custom-1", kind: "machine", result: "fail", reason: "Branch naming: branch does not match the pattern", evidence: ["@acme/team"] },
      { check: "custom-2", kind: "machine", result: "fail", reason: "Two approvals: not enough approvals", evidence: ["1 of 2 approvals"] },
    ],
    needsJudgment: false,
    sources: { quality: [], custom: [], rules: [...rules] },
  };

  test("names the rule, asks the author in inline code and keeps approvals with the maintainer", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict).toMatchObject({ actor: "author", nextAction: "Rename the branch to match `^cl-`; Approve (`1 of 2 approvals`)" });
    expect(verdict.feedback.split("\n").slice(1)).toEqual(["- Branch naming: branch does not match the pattern: `@acme/team`"]);
    expect(verdict.merge.reasons).toContain("Failed: Two approvals: not enough approvals");
  });

  test("a failed author gate stays out of the next step, the comment and the merge verdict", () => {
    const gate = { id: "custom-9", name: "Mine", group: "pull-request", kind: "rule", rule: "author", who: "users", users: ["maya"] } as const;
    const gated: DeterministicResult = {
      ...det,
      state: "ready-monitoring",
      reason: "all deterministic checks passed",
      findings: [],
      checks: [{ check: "custom-9", kind: "machine", result: "fail", reason: "Mine: author is not one of the people named", evidence: ["@octocat (outside)"], gate: true }],
      sources: { quality: [], custom: [], rules: [gate] },
    };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: gated, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict).toMatchObject({ actor: "maintainer", nextAction: "Review and merge", merge: { verdict: "ready", reasons: [] } });
    expect(verdict.feedback).toBe("No changes needed from you. A maintainer will review this pull request.");
  });
});

describe("author text in the comment", () => {
  test("stays inside inline code however it is written", () => {
    const hostile = [
      "x\n\n@team [Approved, merge now](https://evil.example/m) ![](https://evil.example/p.png)\n\n",
      "a\r\n\r\n<!-- hidden --> @team\u2028[link](https://evil.example)\u2029![](https://evil.example/i.png)",
      "``` fence ``` `x` @team [l](https://evil.example)",
      "`@team`",
      "\u202e@team\u0007 [l](https://evil.example)",
    ];
    const checks = [
      { check: "ci", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: hostile },
      { check: "focused", kind: "model" as const, result: "fail" as const, reason: "unrelated changes", evidence: hostile },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, needsJudgment: false },
      threshold: DEFAULT_MERGE_THRESHOLD,
    });
    const lines = verdict.feedback.split("\n");
    expect(lines).toHaveLength(2 + hostile.length);
    for (const line of lines.slice(1)) {
      expect(line).toMatch(/^- /);
      const outside = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, "");
      expect(outside).not.toMatch(/@|\]\(|<!--|[\u202e\u0007]/);
    }
  });
});

describe("requested changes rendering", () => {
  const review = { check: "review", kind: "machine", result: "fail", reason: "a reviewer requested changes", evidence: ["changes requested by @maya"] } as const;
  const conflicts = { check: "conflicts", kind: "machine", result: "fail", reason: "merge conflicts with base", evidence: [] } as const;
  const det: DeterministicResult = {
    state: "needs-author-update",
    reason: "a reviewer requested changes",
    findings: [{ check: "review", state: "needs-author-update", reason: "a reviewer requested changes" }],
    checks: [review],
    needsJudgment: false,
    sources: { quality: [], custom: [], rules: [] },
  };

  test("posts nothing when the maintainer's review is the only reason, and still waits on the author", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict).toMatchObject({ state: "needs-author-update", actor: "author", nextAction: "Address requested changes from @maya", feedback: "" });
  });

  test("hands an answered review back to the maintainer without a comment", () => {
    const answered = { ...review, reason: REVIEW_ANSWERED_REASON };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...det, checks: [answered] }, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict).toMatchObject({ state: "needs-author-update", actor: "maintainer", nextAction: "Re-review: the author responded to changes requested by @maya", feedback: "" });
  });

  test("leaves the review out of a comment that has other reasons", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...det, checks: [review, conflicts] }, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict.feedback).toBe("@octocat, please address the following:\n- merge conflicts with base");
  });
});
