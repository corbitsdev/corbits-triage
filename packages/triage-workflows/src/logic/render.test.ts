import { describe, expect, test } from "bun:test";
import { classificationSources, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict, toMirrorRequest } from "./render.js";
import { focusedCandidateId, qualityQuestions } from "./quality.js";
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

function focusedVerdict(candidates: ChangeCandidate[], reply: string) {
  return renderVerdict({
    author: "octocat",
    det: FOCUSED_DET,
    answers: parseAnswers(reply),
    candidates,
  });
}

describe("focused candidate rendering", () => {
  test("orders confirmed unrelated candidates in evidence and one reply line each", () => {
    const candidates = [candidate("src/alpha.ts", "Alpha"), candidate("src/beta.ts", "Beta")];
    const verdict = focusedVerdict(candidates, [
      decision("focused-candidate-001", "unrelated"),
      decision("focused-candidate-002", "unrelated"),
    ].join(""));
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, humanGated: false, confidence: 0.9 });
    expect(verdict.checks).toEqual([{
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["Alpha — src/alpha.ts", "Beta — src/beta.ts"],
    }]);
    expect(verdict.reason).toContain("Alpha — src/alpha.ts, Beta — src/beta.ts");
    expect(verdict.feedback.split("\n").slice(1)).toEqual([
      "- Split out unrelated change: Alpha — src/alpha.ts",
      "- Split out unrelated change: Beta — src/beta.ts",
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
    ["missing", [candidate("src/a.ts", "A")], ""],
    ["malformed", [candidate("src/a.ts", "A")], JSON.stringify({ id: "focused-candidate-001", type: "choice", choice: "unrelated", probabilities: { unrelated: 1 }, confidence: 2 })],
    ["empty evidence", [candidate("src/a.ts", "A", "")], decision("focused-candidate-001", "unrelated")],
    ["no candidates", [], ""],
  ] as const)("human-gates %s without a generic focused accusation", (_name, candidates, reply) => {
    const verdict = focusedVerdict([...candidates], reply);
    expect(verdict).toMatchObject({ state: "ready-monitoring", mirror: false, humanGated: true });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: expect.any(String), evidence: [] }]);
    expect(verdict.feedback).toBe("");
    expect(verdict.reason).not.toContain("mixes unrelated changes");
  });

  test("names confirmed unrelated candidates but human-gates a mixed unresolved result", () => {
    const verdict = focusedVerdict(
      [candidate("src/a.ts", "A"), candidate("src/b.ts", "B")],
      decision("focused-candidate-001", "unrelated") + decision("focused-candidate-002", "ambiguous"),
    );
    expect(verdict).toMatchObject({ mirror: false, humanGated: true });
    expect(verdict.checks[0]).toMatchObject({ check: "focused", result: "fail", evidence: ["A — src/a.ts"] });
    expect(verdict.feedback.split("\n").slice(1)).toEqual(["- Split out unrelated change: A — src/a.ts"]);
  });

  test("rejects duplicate decisions and illegal choice probability keys", () => {
    const duplicate = decision("focused-candidate-001", "unrelated") + decision("focused-candidate-001", "unrelated");
    expect(focusedVerdict([candidate("a.ts", "A")], duplicate)).toMatchObject({ mirror: false, humanGated: true });
    const illegal = JSON.stringify({
      id: "focused-candidate-001",
      type: "choice",
      choice: "unrelated",
      probabilities: { unrelated: 0.9, other: 0.1 },
      confidence: 0.9,
    });
    expect(focusedVerdict([candidate("a.ts", "A")], illegal)).toMatchObject({ mirror: false, humanGated: true });
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
    const verdict = renderVerdict({ author: "octocat", det, answers, candidates: [] });
    expect(verdict).toMatchObject({ state: "needs-author-update", mirror: true, confidence: 0.8 });
    expect(verdict.checks.map(({ check, result }) => ({ check, result }))).toEqual([
      { check: "docs", result: "fail" },
      { check: "custom-1", result: "pass" },
    ]);

    const duplicate = parseAnswers('{"id":"docs","type":"noul","noul":0.9}{"id":"docs","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", det, answers: duplicate, candidates: [] })).toMatchObject({ mirror: false, degraded: "inference-outage" });
    const unknown = parseAnswers('{"id":"other","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", det, answers: unknown, candidates: [] })).toMatchObject({ mirror: false, degraded: "inference-outage" });
  });

  test("human-gates complete max-candidate feedback instead of mirroring an oversized or partial comment", () => {
    const candidates = Array.from({ length: 200 }, (_, index) => candidate(
      `${"p".repeat(500)}-${String(index).padStart(3, "0")}.ts`,
      `${"L".repeat(150)}-${String(index).padStart(3, "0")}`,
    ));
    const reply = candidates.map((_, index) => decision(focusedCandidateId(index), "unrelated")).join("");
    const verdict = focusedVerdict(candidates, reply);
    const lines = verdict.feedback.split("\n").slice(1);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeGreaterThan(MAX_MIRROR_COMMENT_BYTES);
    expect(lines).toHaveLength(200);
    expect(lines[0]).toContain(candidates[0]!.label);
    expect(lines.at(-1)).toContain(candidates.at(-1)!.label);
    expect(verdict).toMatchObject({
      mirror: false,
      humanGated: true,
      actor: "author",
    });
    expect(verdict.reason).toContain(`mixes unrelated changes: ${candidates[0]!.label} — ${candidates[0]!.path}`);
    expect(verdict.nextAction).toContain(`Split out unrelated change: ${candidates[0]!.label} — ${candidates[0]!.path}`);
    expect(verdict.checks[0]?.evidence).toHaveLength(200);
  });

  test("suppresses oversized deterministic feedback without replacing its CI and path verdict", () => {
    const failingOutput = "界".repeat(21_000);
    const checks = [
      { check: "ci", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: [failingOutput] },
      { check: "paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/generated.ts"] },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      det: {
        state: "blocked",
        reason: "required checks are failing",
        findings: [],
        checks,
        duplicateOf: null,
        needsJudgment: false,
      },
    });
    expect(verdict.feedback.length).toBeLessThan(MAX_MIRROR_COMMENT_BYTES);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeGreaterThan(MAX_MIRROR_COMMENT_BYTES);
    expect(verdict).toMatchObject({
      state: "blocked",
      reason: "required checks are failing",
      actor: "author",
      mirror: false,
      humanGated: true,
      checks,
    });
    expect(verdict.nextAction).toContain("Fix failing CI");
    expect(verdict.nextAction).toContain("Remove changes under vendor/generated.ts");
    expect(`${verdict.reason}\n${verdict.nextAction}`).not.toContain("unrelated change");
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
