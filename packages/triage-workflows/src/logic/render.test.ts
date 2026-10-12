import { describe, expect, test } from "bun:test";
import { classificationSources, DEFAULT_MERGE_THRESHOLD, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict, toMirrorRequest } from "./render.js";
import { focusedCandidateId, QUALITY_EVALUATION_LIMIT_ERROR, type QualityPlan } from "./quality.js";
import type { ChangeCandidate } from "./candidates.js";
import { REVIEW_ANSWERED_REASON, type DeterministicResult } from "./checks.js";

describe("duplicate rendering", () => {
  test("keeps a detected duplicate open until a human requests close", () => {
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: {
        state: "needs-decision",
        reason: "matches #7",
        findings: [],
        checks: [],
        duplicateOf: 7,
        needsJudgment: false,
      },
      threshold: DEFAULT_MERGE_THRESHOLD,
    });

    expect(verdict.duplicate).toBe(true);
    expect(verdict.close).toBe(false);
    expect(toMirrorRequest({ repo: "acme/widgets", number: 8, ...verdict })).toMatchObject({
      repo: "acme/widgets",
      number: 8,
      close: false,
    });
  });
});

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
        duplicateOf: null,
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
  duplicateOf: null,
  needsJudgment: true,
  sources: FOCUSED_SOURCES,
};
const CHOICES = ["primary_or_supporting", "unrelated", "movement_or_superseded", "ambiguous"] as const;

function decision(id: string, choice: typeof CHOICES[number]): string {
  const probabilities = Object.fromEntries(CHOICES.map((option) => [option, option === choice ? 0.7 : 0.1]));
  return JSON.stringify({ id, type: "choice", choice, probabilities, confidence: 0.9 });
}

function candidate(path: string, label: string, evidence = `@@ -0,0 +1 @@\n+const value = { name: "${label}" };`): ChangeCandidate {
  return { path, label, evidence };
}

function focusedVerdict(candidates: ChangeCandidate[], reply: string, threshold = DEFAULT_MERGE_THRESHOLD) {
  return renderVerdict({
    author: "octocat",
    repo: "acme/widgets",
    headSha: "abc123",
    det: FOCUSED_DET,
    answers: parseAnswers(reply),
    candidates,
    threshold,
  });
}

const UNSURE_FOCUSED = "Not yet confirmed, a maintainer will check:\n- makes one focused change";
const OUTAGE_NOTE = "Some checks could not run this time. Triage will re-check this pull request.";
const APPROVAL_NOTE = "No changes needed from you. A maintainer will review this pull request.";

describe("focused candidate rendering", () => {
  test("orders confirmed unrelated candidates in evidence and one reply line each", () => {
    const candidates = [candidate("src/alpha.ts", "Alpha"), candidate("src/beta.ts", "Beta")];
    const verdict = focusedVerdict(candidates, [
      decision("focused-candidate-001", "unrelated"),
      decision("focused-candidate-002", "unrelated"),
    ].join(""));
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, humanGated: false, score: 0.7, confidence: 0.7 });
    expect(verdict.checks).toEqual([{
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["Alpha — src/alpha.ts", "Beta — src/beta.ts"],
      output: { kind: "score", score: 20, passAt: 60, items: ["Alpha — src/alpha.ts", "Beta — src/beta.ts"] },
    }]);
    expect(verdict.reason).toContain("Alpha — src/alpha.ts, Beta — src/beta.ts");
    expect(verdict.feedback.split("\n").slice(1)).toEqual([
      "- Split out unrelated change: `Alpha — src/alpha.ts`",
      "- Split out unrelated change: `Beta — src/beta.ts`",
    ]);
  });

  test.each([
    ["primary or supporting", "primary_or_supporting"],
    ["movement or superseded", "movement_or_superseded"],
  ] as const)("treats %s as focused", (_name, choice) => {
    const verdict = focusedVerdict([candidate("src/a.ts", "A")], decision("focused-candidate-001", choice));
    expect(verdict).toMatchObject({ state: "ready-monitoring", mirror: true, humanGated: false });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "makes one focused change", evidence: [], output: { kind: "score", score: 80, passAt: 60, items: ["A — src/a.ts"] } }]);
  });

  test("passes only a fully read pull request, and a failure still lists what it could not read", () => {
    const candidates = [candidate("src/a.ts", "A"), candidate("src/big.ts", "Big", ""), candidate("src/big.ts", "Big", "")];
    const related = focusedVerdict(candidates, decision("focused-candidate-001", "primary_or_supporting"));
    expect(related.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "not enough evidence to decide", evidence: [], output: { kind: "could-not-check", reason: "file could not be read", items: ["src/big.ts"] } }]);
    const unrelated = focusedVerdict(candidates, decision("focused-candidate-001", "unrelated"));
    expect(unrelated.checks[0]).toMatchObject({ result: "fail", output: { kind: "score", items: ["A — src/a.ts"], unread: ["src/big.ts"] } });
  });

  test.each([
    ["ambiguous", [candidate("src/a.ts", "A")], decision("focused-candidate-001", "ambiguous"), { kind: "score", score: 20, passAt: 60, items: ["A — src/a.ts"] }],
    ["split", [candidate("src/a.ts", "A")], JSON.stringify({
      id: "focused-candidate-001", type: "choice", choice: "unrelated", confidence: 0.9,
      probabilities: { primary_or_supporting: 0.35, unrelated: 0.5, movement_or_superseded: 0.05, ambiguous: 0.1 },
    }), { kind: "score", score: 40, passAt: 60, items: ["A — src/a.ts"] }],
    ["empty evidence", [candidate("src/a.ts", "A", "")], decision("focused-candidate-001", "unrelated"), { kind: "could-not-check", reason: "file could not be read", items: ["src/a.ts"] }],
    ["no candidates", [], "", { kind: "could-not-check", reason: "no change candidates" }],
  ] as const)("names an unsure focused check (%s) in the comment, awaits review and is red", (_name, candidates, reply, output) => {
    const verdict = focusedVerdict([...candidates], reply);
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, merge: { verdict: "not-recommended" } });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: expect.any(String), evidence: [], output }]);
    expect(verdict.feedback).toBe(UNSURE_FOCUSED);
    expect(verdict.merge.reasons).toContain("Not confirmed: makes one focused change");
    expect(verdict.reason).not.toContain("mixes unrelated changes");
  });

  test.each([
    ["missing", ""],
    ["malformed", JSON.stringify({ id: "focused-candidate-001", type: "choice", choice: "unrelated", probabilities: { unrelated: 1 }, confidence: 2 })],
  ] as const)("a %s answer is an outage that still posts", (_name, reply) => {
    const verdict = focusedVerdict([candidate("src/a.ts", "A")], reply);
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: "inference-outage", feedback: OUTAGE_NOTE });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: null, threshold: DEFAULT_MERGE_THRESHOLD, reasons: ["Could not evaluate 1 check"] });
  });

  test("the judge budget and a judge outage both still post", () => {
    const candidates = [candidate("src/a.ts", "A")];
    const limited = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, candidates, judgeError: QUALITY_EVALUATION_LIMIT_ERROR, judgeLimitExceeded: true, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(limited).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, feedback: UNSURE_FOCUSED });
    expect(limited.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: QUALITY_EVALUATION_LIMIT_ERROR, evidence: [], output: { kind: "could-not-check", reason: QUALITY_EVALUATION_LIMIT_ERROR } }]);
    expect(limited.reason).toBe(QUALITY_EVALUATION_LIMIT_ERROR);
    const outage = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, candidates, judgeError: "upstream 503", threshold: DEFAULT_MERGE_THRESHOLD });
    expect(outage).toMatchObject({ mirror: true, humanGated: false, degraded: "inference-outage", feedback: OUTAGE_NOTE });
  });

  test("names confirmed unrelated candidates when another is unresolved", () => {
    const verdict = focusedVerdict(
      [candidate("src/a.ts", "A"), candidate("src/b.ts", "B")],
      decision("focused-candidate-001", "unrelated") + decision("focused-candidate-002", "ambiguous"),
    );
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, humanGated: false });
    expect(verdict.checks[0]).toMatchObject({ check: "focused", result: "fail", evidence: ["A — src/a.ts"] });
    expect(verdict.feedback.split("\n").slice(1)).toEqual(["- Split out unrelated change: `A — src/a.ts`"]);
  });

  test("dedupes exact unrelated display evidence only after validating every candidate", () => {
    const candidates = [
      candidate("src/a.ts", "Repeated"),
      candidate("src/a.ts", "Repeated"),
      candidate("src/a.ts", "Distinct"),
    ];
    const allUnrelated = focusedVerdict(candidates, [0, 1, 2].map((index) => decision(focusedCandidateId(index), "unrelated")).join(""));
    expect(allUnrelated.checks[0]?.evidence).toEqual(["Repeated — src/a.ts", "Distinct — src/a.ts"]);
    expect(allUnrelated.feedback.split("\n").slice(1)).toEqual([
      "- Split out unrelated change: `Repeated — src/a.ts`",
      "- Split out unrelated change: `Distinct — src/a.ts`",
    ]);
    expect(allUnrelated.reason).toContain("Repeated — src/a.ts, Distinct — src/a.ts");

    const unresolvedDuplicate = focusedVerdict(candidates, [
      decision("focused-candidate-001", "unrelated"),
      decision("focused-candidate-002", "ambiguous"),
      decision("focused-candidate-003", "unrelated"),
    ].join(""));
    expect(unresolvedDuplicate).toMatchObject({ mirror: true, humanGated: false });
    expect(unresolvedDuplicate.checks[0]?.evidence).toEqual(["Repeated — src/a.ts", "Distinct — src/a.ts"]);
  });

  test("rejects duplicate decisions and illegal choice probability keys", () => {
    const duplicate = decision("focused-candidate-001", "unrelated") + decision("focused-candidate-001", "unrelated");
    expect(focusedVerdict([candidate("a.ts", "A")], duplicate)).toMatchObject({ degraded: "inference-outage" });
    const illegal = JSON.stringify({
      id: "focused-candidate-001",
      type: "choice",
      choice: "unrelated",
      probabilities: { unrelated: 0.9, other: 0.1 },
      confidence: 0.9,
    });
    expect(focusedVerdict([candidate("a.ts", "A")], illegal)).toMatchObject({ degraded: "inference-outage" });
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
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, candidates: [], plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks.map(({ check, result, evidence }) => [check, result, evidence]);
    }
    expect(results(0.9, 0.2)).toEqual([["tests", "fail", ["src/a.ts"]], ["custom-1", "fail", []]]);
    expect(results(0.5, 0.5)).toEqual([["tests", "unconfirmed", []], ["custom-1", "unconfirmed", []]]);
    expect(results(0.2, 0.9)).toEqual([["tests", "pass", []], ["custom-1", "pass", []]]);

    const duplicate = parseAnswers('{"id":"custom-1","type":"noul","noul":0.9}{"id":"custom-1","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: duplicate, candidates: [], plan, threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
    const unknown = parseAnswers('{"id":"tests","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: unknown, candidates: [], plan, threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
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
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, candidates: [], plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks.map(({ result, output }) => [result, output]);
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
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul({ "tests-file-001": answer, "custom-1": answer }), candidates: [], plan, threshold: DEFAULT_MERGE_THRESHOLD }).checks;
    }
    function focusedCheck(related: number) {
      const probabilities = { primary_or_supporting: related, unrelated: 0.2, movement_or_superseded: 0, ambiguous: 0.8 - related };
      return focusedVerdict([candidate("src/a.ts", "A")], JSON.stringify({ id: "focused-candidate-001", type: "choice", choice: "ambiguous", probabilities, confidence: 0.9 })).checks;
    }
    const checks = [0.3, 0.305, 0.695, 0.7].flatMap(modelChecks).concat([0.595, 0.6].flatMap(focusedCheck));
    for (const check of checks) {
      if (check.output.kind !== "score") throw new Error(`${check.check} has no score`);
      expect([check.check, check.output.score >= check.output.passAt]).toEqual([check.check, check.result === "pass"]);
    }
    expect(checks.map((check) => check.result)).toContain("pass");
  });

  test("a failing focused check scores the unrelated candidates its evidence names", () => {
    const unrelated = { primary_or_supporting: 0.3, unrelated: 0.6, movement_or_superseded: 0, ambiguous: 0.1 };
    const unsure = { primary_or_supporting: 0.2, unrelated: 0.2, movement_or_superseded: 0, ambiguous: 0.6 };
    const reply = [unrelated, unsure].map((probabilities, index) => JSON.stringify({ id: focusedCandidateId(index), type: "choice", choice: "ambiguous", probabilities, confidence: 0.9 })).join("");
    const [check] = focusedVerdict([candidate("src/a.ts", "A"), candidate("src/b.ts", "B")], reply).checks;
    expect(check).toMatchObject({ result: "fail", evidence: ["A — src/a.ts"], output: { kind: "score", score: expect.closeTo(30), passAt: 60, items: ["A — src/a.ts"] } });
  });

  test("an over-long comment is cut at line boundaries and still posts", () => {
    const candidates = Array.from({ length: 200 }, (_, index) => candidate(
      `${"p".repeat(500)}-${String(index).padStart(3, "0")}.ts`,
      `${"界".repeat(150)}-${String(index).padStart(3, "0")}`,
    ));
    const reply = candidates.map((_, index) => decision(focusedCandidateId(index), "unrelated")).join("");
    const verdict = focusedVerdict(candidates, reply);
    const lines = verdict.feedback.split("\n").slice(1);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeLessThanOrEqual(MAX_MIRROR_COMMENT_BYTES);
    expect(lines[0]).toContain(candidates[0]!.label);
    expect(lines.at(-1)).toBe(`- and ${200 - (lines.length - 1)} more`);
    expect(lines.length).toBeGreaterThan(50);
    expect(verdict).toMatchObject({ mirror: true, humanGated: false, actor: "author" });
    expect(verdict.checks[0]?.evidence).toHaveLength(200);
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
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, duplicateOf: null, needsJudgment: false },
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

  test("an unsure focused check is red", () => {
    const verdict = focusedVerdict([candidate("src/a.ts", "A")], decision("focused-candidate-001", "ambiguous"));
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: null, threshold: DEFAULT_MERGE_THRESHOLD, reasons: ["Not confirmed: makes one focused change"] });
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
    duplicateOf: null,
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
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, duplicateOf: null, needsJudgment: false },
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
    duplicateOf: null,
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
