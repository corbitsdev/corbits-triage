import { describe, expect, test } from "bun:test";
import { classificationSources, DEFAULT_MERGE_THRESHOLD, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict, toMirrorRequest } from "./render.js";
import { focusedCandidateId, QUALITY_EVALUATION_LIMIT_ERROR, qualityQuestions } from "./quality.js";
import type { ChangeCandidate } from "./candidates.js";
import type { DeterministicResult } from "./checks.js";

describe("duplicate rendering", () => {
  test("keeps a detected duplicate open until a human requests close", () => {
    const verdict = renderVerdict({
      author: "octocat",
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
      { check: "custom-2", kind: "model", result: "fail", reason: 'does not meet "Ticket"', evidence: [] },
    ]);
  });
});

const FOCUSED_SOURCES = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] };
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

function decision(id: string, choice: typeof CHOICES[number], confidence = 0.9): string {
  const probabilities = Object.fromEntries(CHOICES.map((option) => [option, option === choice ? 0.7 : 0.1]));
  return JSON.stringify({ id, type: "choice", choice, probabilities, confidence });
}

function candidate(path: string, label: string, evidence = `@@ -0,0 +1 @@\n+const value = { name: "${label}" };`): ChangeCandidate {
  return { path, label, evidence };
}

function focusedVerdict(candidates: ChangeCandidate[], reply: string, threshold = DEFAULT_MERGE_THRESHOLD) {
  return renderVerdict({
    author: "octocat",
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
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, humanGated: false, score: 0.9, confidence: 0.9 });
    expect(verdict.checks).toEqual([{
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["Alpha — src/alpha.ts", "Beta — src/beta.ts"],
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
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "makes one focused change", evidence: [] }]);
  });

  test.each([
    ["ambiguous", [candidate("src/a.ts", "A")], decision("focused-candidate-001", "ambiguous")],
    ["low confidence", [candidate("src/a.ts", "A")], decision("focused-candidate-001", "unrelated", 0.49)],
    ["empty evidence", [candidate("src/a.ts", "A", "")], decision("focused-candidate-001", "unrelated")],
    ["no candidates", [], ""],
  ] as const)("names an unsure focused check (%s) in the comment, awaits review and is red", (_name, candidates, reply) => {
    const verdict = focusedVerdict([...candidates], reply);
    expect(verdict).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, merge: { verdict: "not-recommended" } });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: expect.any(String), evidence: [] }]);
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
    const limited = renderVerdict({ author: "octocat", det: FOCUSED_DET, candidates, judgeError: QUALITY_EVALUATION_LIMIT_ERROR, judgeLimitExceeded: true, threshold: DEFAULT_MERGE_THRESHOLD });
    expect(limited).toMatchObject({ state: "awaiting-review", mirror: true, humanGated: false, degraded: null, feedback: UNSURE_FOCUSED });
    expect(limited.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: QUALITY_EVALUATION_LIMIT_ERROR, evidence: [] }]);
    expect(limited.reason).toBe(QUALITY_EVALUATION_LIMIT_ERROR);
    const outage = renderVerdict({ author: "octocat", det: FOCUSED_DET, candidates, judgeError: "upstream 503", threshold: DEFAULT_MERGE_THRESHOLD });
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

  test("strictly validates noul decisions and keeps noul certainty semantics", () => {
    const det: DeterministicResult = {
      ...FOCUSED_DET,
      sources: {
        quality: [{ id: "docs", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
      },
    };
    const answers = parseAnswers([
      JSON.stringify({ id: "docs", type: "noul", noul: 0.2 }),
      JSON.stringify({ id: "custom-1", type: "noul", noul: 0.9 }),
    ].join(""));
    const verdict = renderVerdict({ author: "octocat", det, answers, candidates: [], threshold: DEFAULT_MERGE_THRESHOLD });
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, score: 0.8 });
    expect(verdict.checks.map(({ check, result }) => ({ check, result }))).toEqual([
      { check: "docs", result: "fail" },
      { check: "custom-1", result: "pass" },
    ]);

    const duplicate = parseAnswers('{"id":"docs","type":"noul","noul":0.9}{"id":"docs","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", det, answers: duplicate, candidates: [], threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
    const unknown = parseAnswers('{"id":"other","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", det, answers: unknown, candidates: [], threshold: DEFAULT_MERGE_THRESHOLD })).toMatchObject({ mirror: true, degraded: "inference-outage" });
  });

  test("an over-long comment is cut at line boundaries and still posts", () => {
    const candidates = Array.from({ length: 200 }, (_, index) => candidate(
      `${"p".repeat(500)}-${String(index).padStart(3, "0")}.ts`,
      `${"L".repeat(150)}-${String(index).padStart(3, "0")}`,
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

  test("an over-long CI line is cut without replacing its CI and path verdict", () => {
    const checks = [
      { check: "ci", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: ["界".repeat(21_000)] },
      { check: "paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/generated.ts"] },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, duplicateOf: null, needsJudgment: false },
      threshold: DEFAULT_MERGE_THRESHOLD,
    });
    expect(verdict.feedback).toBe("@octocat, please address the following:\n- and 2 more");
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", mirror: true, humanGated: false, checks });
    expect(verdict.nextAction).toContain("Fix failing CI");
    expect(verdict.nextAction).toContain("Remove changes under vendor/generated.ts");
  });
});

const MODEL_DET: DeterministicResult = {
  ...FOCUSED_DET,
  sources: { quality: [{ id: "docs", group: "code-vs-ci" }, { id: "tests", group: "code-vs-ci" }], custom: [] },
};

function noul(answers: Record<string, number>) {
  return parseAnswers(Object.entries(answers).map(([id, value]) => JSON.stringify({ id, type: "noul", noul: value })).join(""));
}

describe("merge verdict", () => {
  test("every check passing at or above the threshold is ready", () => {
    const verdict = renderVerdict({ author: "octocat", det: MODEL_DET, answers: noul({ docs: 0.9, tests: 0.8 }), threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "ready", score: 0.8, threshold: 0.7, reasons: [] });
    expect(verdict).toMatchObject({ state: "ready-monitoring", mirror: true, feedback: APPROVAL_NOTE });
  });

  test("every check passing below the threshold is red with the score reason", () => {
    const verdict = renderVerdict({ author: "octocat", det: MODEL_DET, answers: noul({ docs: 0.9, tests: 0.6 }), threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.6, threshold: 0.7, reasons: ["Score 0.6 is below the threshold 0.7"] });
    expect(verdict.feedback).toBe(APPROVAL_NOTE);
  });

  test("a failing rule is red", () => {
    const checks = [{ check: "paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/a.ts"] }];
    const verdict = renderVerdict({ author: "octocat", det: { ...MODEL_DET, state: "blocked", checks }, answers: noul({ docs: 0.9, tests: 0.9 }), threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.9, threshold: 0.7, reasons: ["Failed: touches forbidden paths"] });
  });

  test("an unsure focused check is red", () => {
    const verdict = focusedVerdict([candidate("src/a.ts", "A")], decision("focused-candidate-001", "ambiguous"));
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.9, threshold: DEFAULT_MERGE_THRESHOLD, reasons: ["Not confirmed: makes one focused change"] });
  });

  test("a failed chunk is red with the count of checks it could not evaluate and keeps the answered ones", () => {
    const det: DeterministicResult = { ...MODEL_DET, sources: { ...MODEL_DET.sources!, custom: [{ id: "custom-1", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "Names a ticket." }] } };
    const verdict = renderVerdict({ author: "octocat", det, answers: noul({ docs: 0.2 }), judgeError: "upstream 503", threshold: 0.7 });
    expect(verdict.checks.map(({ check, result }) => [check, result])).toEqual([["docs", "fail"], ["tests", "unconfirmed"], ["custom-1", "unconfirmed"]]);
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, degraded: "inference-outage" });
    expect(verdict.merge).toEqual({ verdict: "not-recommended", score: 0.8, threshold: 0.7, reasons: ["Could not evaluate 2 checks", "Failed: documentation is not updated"] });
    expect(verdict.feedback).toBe(`@octocat, please address the following:\n- documentation is not updated\n\n${OUTAGE_NOTE}`);
  });

  test("rules only has no score and is green", () => {
    const checks = [{ check: "ci", kind: "machine" as const, result: "pass" as const, reason: "required checks pass", evidence: [] }];
    const verdict = renderVerdict({ author: "octocat", det: { ...FOCUSED_DET, checks, needsJudgment: false, sources: undefined }, threshold: 0.7 });
    expect(verdict.merge).toEqual({ verdict: "ready", score: null, threshold: 0.7, reasons: [] });
    expect(verdict).toMatchObject({ score: null, confidence: "unknown", mirror: true, feedback: APPROVAL_NOTE });
  });

  test("a closed pull request gets no comment", () => {
    const findings = [{ check: "state", state: "ready-monitoring" as const, reason: "pull request is closed" }];
    const verdict = renderVerdict({ author: "octocat", det: { ...MODEL_DET, findings, checks: [], needsJudgment: false }, threshold: 0.7 });
    expect(verdict).toMatchObject({ mirror: true, feedback: "" });
  });
});

describe("quality question compatibility", () => {
  test("replaces only focused while docs, tests, and custom questions stay boolean", () => {
    const questions = qualityQuestions({
      quality: [
        { id: "focused", group: "pull-request" },
        { id: "docs", group: "code-vs-ci" },
        { id: "tests", group: "code-vs-ci" },
      ],
      custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
    }, [candidate("src/a.ts", "A")]);
    expect(questions.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "focused-candidate-001", type: "choice" },
      { id: "docs", type: "boolean" },
      { id: "tests", type: "boolean" },
      { id: "custom-1", type: "boolean" },
    ]);
    expect(questions[0]?.instructions).toContain("changeCandidates.focused-candidate-001");
    expect(questions[0]?.instructions).toContain("supporting");
    expect(questions[0]?.instructions).toContain("movement_or_superseded");
  });
});
