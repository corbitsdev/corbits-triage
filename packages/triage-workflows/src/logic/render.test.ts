import { describe, expect, test } from "bun:test";
import { classificationSources, emptyPack, type CheckPack } from "@corbits/triage-contracts";
import { MAX_MIRROR_COMMENT_BYTES, parseAnswers, renderVerdict } from "./render.js";
import { QUALITY_EVALUATION_LIMIT_ERROR, type FocusedPlan, type QualityPlan } from "./quality.js";
import { REVIEW_ANSWERED_REASON, type DeterministicResult } from "./checks.js";

describe("custom check rendering", () => {
  test("a model row is answered by its stored id", () => {
    const pack: CheckPack = {
      ...emptyPack("acme/widgets"),
      custom: [
        { id: "custom-2", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "The title mentions a ticket id." },
      ],
    };
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: {
        state: "ready-monitoring",
        reason: "all deterministic rules passed",
        findings: [],
        checks: [],
        needsJudgment: true,
        sources: classificationSources(pack),
      },
      answers: { "custom-2": 0.1 },
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

function focusedPlan(separate: Record<string, number>, slices: Record<string, string[]> = { focused: Object.keys(separate) }, unread: string[] = []): { focused: FocusedPlan; nouls: string } {
  const ids = Object.keys(separate).map((_, index) => `focused-file-${String(index + 1).padStart(3, "0")}`);
  const parts = Object.fromEntries(Object.keys(separate).map((path, index) => [ids[index]!, path]));
  const nouls = Object.values(separate).map((noul, index) => JSON.stringify({ id: ids[index], type: "noul", noul })).join("");
  return { focused: { slices, unread, parts }, nouls };
}

const CHOICE = {
  pass: { pass: 0.8, fail: 0.1, cant_tell: 0.1 },
  fail: { pass: 0.1, fail: 0.85, cant_tell: 0.05 },
  unsure: { pass: 0.5, fail: 0.3, cant_tell: 0.2 },
} as const;

function focusedVerdict(reply: string, focused: FocusedPlan = focusedPlan({}).focused, choice: Record<"pass" | "fail" | "cant_tell", number> = CHOICE.pass) {
  return renderVerdict({
    author: "octocat",
    repo: "acme/widgets",
    headSha: "abc123",
    det: FOCUSED_DET,
    answers: parseAnswers(reply),
    focused,
    choice,
  });
}

const UNSURE = "**Triage: Unsure**\n\n";
const UNSURE_FOCUSED = "Not yet confirmed, a maintainer will check:\n- makes one focused change";
const OUTAGE_NOTE = "Some rules could not run this time. Triage will re-check this pull request.";

describe("focused rendering", () => {
  test("fails on more than one thing, whatever the verdict question says, naming at most three files most likely to be the separate change", () => {
    const { focused, nouls } = focusedPlan({ "src/a.ts": 0.1, "src/b.ts": 0.75, "src/c.ts": 0.9, "src/d.ts": 0.8, "src/e.ts": 0.71, "src/f.ts": 0.6 });
    const verdict = focusedVerdict(focusedAnswer(0.1, 0.85) + nouls, focused, CHOICE.pass);
    expect(verdict).toMatchObject({ verdict: "fail", state: "needs-author-update", mirror: true, humanGated: false, score: null });
    expect(verdict.checks).toEqual([{
      check: "focused",
      kind: "model",
      result: "fail",
      reason: "mixes unrelated changes",
      evidence: ["src/c.ts", "src/d.ts", "src/b.ts"],
      output: { kind: "score", score: expect.closeTo(10), passAt: 60, items: ["src/c.ts", "src/d.ts", "src/b.ts"] },
    }]);
    expect(verdict.reason).toBe("mixes unrelated changes: src/c.ts, src/d.ts, src/b.ts");
    expect(verdict.feedback.split("\n").slice(3)).toEqual([
      "- Split out unrelated change: `src/c.ts`",
      "- Split out unrelated change: `src/d.ts`",
      "- Split out unrelated change: `src/b.ts`",
    ]);
  });

  test("still fails when no file is clearly the separate change", () => {
    const { focused, nouls } = focusedPlan({ "src/a.ts": 0.5 });
    const verdict = focusedVerdict(focusedAnswer(0.2, 0.8) + nouls, focused, CHOICE.fail);
    expect(verdict.checks[0]).toMatchObject({ result: "fail", evidence: [], output: { kind: "score", items: [] } });
    expect(verdict.feedback.split("\n").slice(3)).toEqual(["- mixes unrelated changes"]);
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
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, plan: {}, choice: CHOICE.pass });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "pass", reason: "does not apply", evidence: [], output: { kind: "not-applicable" } }]);
    expect(verdict.degraded).toBeNull();
  });

  test("names an unsure focused check in the comment and among the reasons of an unsure verdict", () => {
    const verdict = focusedVerdict(focusedAnswer(0.5, 0.4), undefined, CHOICE.unsure);
    expect(verdict).toMatchObject({ verdict: "unsure", state: "awaiting-review", mirror: true, humanGated: false, degraded: null, score: 0.5, reasons: ["Not confirmed: makes one focused change"] });
    expect(verdict.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: "not enough evidence to decide", evidence: [], output: { kind: "score", score: 50, passAt: 60, items: [] } }]);
    expect(verdict.feedback).toBe(`${UNSURE}${UNSURE_FOCUSED}`);
    expect(focusedVerdict(focusedAnswer(0.5, 0.4), undefined, CHOICE.pass)).toMatchObject({ verdict: "unsure", reason: "the decision model passed it, but a judged rule could not be confirmed" });
  });

  test.each([
    ["missing", ""],
    ["malformed", JSON.stringify({ id: "focused", type: "choice", choice: "one_thing", probabilities: { one_thing: 1 }, confidence: 2 })],
  ] as const)("a %s answer is an outage that still posts", (_name, reply) => {
    const verdict = focusedVerdict(reply);
    expect(verdict).toMatchObject({ verdict: "unsure", state: "awaiting-review", mirror: true, humanGated: false, degraded: "inference-outage", feedback: `${UNSURE}${OUTAGE_NOTE}`, score: null });
  });

  test("the judge budget and a judge outage both still post", () => {
    const limited = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, focused: focusedPlan({}, {}).focused, judgeError: QUALITY_EVALUATION_LIMIT_ERROR, judgeLimitExceeded: true });
    expect(limited).toMatchObject({ verdict: "unsure", state: "awaiting-review", mirror: true, humanGated: false, degraded: null, feedback: `${UNSURE}${UNSURE_FOCUSED}` });
    expect(limited.checks).toEqual([{ check: "focused", kind: "model", result: "unconfirmed", reason: QUALITY_EVALUATION_LIMIT_ERROR, evidence: [], output: { kind: "could-not-check", reason: QUALITY_EVALUATION_LIMIT_ERROR } }]);
    expect(limited.reason).toBe(QUALITY_EVALUATION_LIMIT_ERROR);
    const outage = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: FOCUSED_DET, focused: focusedPlan({}).focused, judgeError: "upstream 503" });
    expect(outage).toMatchObject({ verdict: "unsure", mirror: true, humanGated: false, degraded: "inference-outage", feedback: `${UNSURE}${OUTAGE_NOTE}` });
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
        quality: [{ id: "docs", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const plan: QualityPlan = { docs: { changed: [], asked: { "docs-file-001": "src/a.ts" }, unread: [] } };
    function results(docs: number, custom: number) {
      const answers = noul({ "docs-file-001": docs, "custom-1": custom });
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, plan }).checks.map(({ check, result, evidence }) => [check, result, evidence]);
    }
    expect(results(0.9, 0.2)).toEqual([["docs", "fail", ["src/a.ts"]], ["custom-1", "fail", []]]);
    expect(results(0.5, 0.5)).toEqual([["docs", "unconfirmed", []], ["custom-1", "unconfirmed", []]]);
    expect(results(0.2, 0.9)).toEqual([["docs", "pass", []], ["custom-1", "pass", []]]);

    const duplicate = parseAnswers('{"id":"custom-1","type":"noul","noul":0.9}{"id":"custom-1","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: duplicate, plan })).toMatchObject({ mirror: true, degraded: "inference-outage" });
    const unknown = parseAnswers('{"id":"docs","type":"noul","noul":0.9}');
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: unknown, plan })).toMatchObject({ mirror: true, degraded: "inference-outage" });
  });

  test("a model check scores how likely it is fine, unsure answers included, and a file it could not read is a state", () => {
    const det: DeterministicResult = {
      ...FOCUSED_DET,
      sources: {
        quality: [{ id: "docs", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const asked = { "docs-file-001": "src/a.ts", "docs-file-002": "src/b.ts" };
    function outputs(unread: string[]) {
      const plan: QualityPlan = { docs: { changed: [], asked, unread } };
      const answers = noul({ "docs-file-001": 0.2, "docs-file-002": 0.41, "custom-1": 0.55 });
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers, plan }).checks.map(({ result, output }) => [result, output]);
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
        quality: [{ id: "docs", group: "code-vs-ci" }],
        custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "Keeps boundaries" }],
        rules: [],
      },
    };
    const plan: QualityPlan = { docs: { changed: [], asked: { "docs-file-001": "src/a.ts" }, unread: [] } };
    function modelChecks(answer: number) {
      return renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul({ "docs-file-001": answer, "custom-1": answer }), plan }).checks;
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
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul(Object.fromEntries(custom.map((row) => [row.id, 0.1]))), choice: CHOICE.fail });
    const lines = verdict.feedback.split("\n").slice(3);
    expect(new TextEncoder().encode(verdict.feedback).byteLength).toBeLessThanOrEqual(MAX_MIRROR_COMMENT_BYTES);
    expect(lines[0]).toContain(custom[0]!.name);
    expect(lines.at(-1)).toBe(`- and ${200 - (lines.length - 1)} more`);
    expect(lines.length).toBeGreaterThan(50);
    expect(verdict).toMatchObject({ mirror: true, humanGated: false, actor: "author" });
  });

  test("an over-long CI name is cut to one line without replacing its CI and path verdict", () => {
    const checks = [
      { check: "ci-green", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: ["界".repeat(21_000)], output: { kind: "values" as const, values: {} } },
      { check: "no-forbidden-paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/generated.ts"], output: { kind: "values" as const, values: {} } },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, needsJudgment: false },
    });
    expect(verdict.feedback).toBe(`**Triage: Fail**\n\n@octocat, please address the following:\n- required checks are failing: \`${"界".repeat(200)}…\`\n- touches forbidden paths: \`vendor/generated.ts\``);
    expect(verdict).toMatchObject({ state: "blocked", reason: "required checks are failing", actor: "author", mirror: true, humanGated: false, checks });
    expect(verdict.nextAction).toContain("Fix failing CI");
    expect(verdict.nextAction).toContain("Remove changes under vendor/generated.ts");
  });

  test("both size limits failing ask for one split", () => {
    const checks = [
      { check: "max-files-changed", kind: "machine" as const, result: "fail" as const, reason: "pull request is over the files limit", evidence: ["40 files (max 30)"] },
      { check: "max-lines-changed", kind: "machine" as const, result: "fail" as const, reason: "pull request is over the lines limit", evidence: ["4000 lines changed (max 3000)"] },
    ];
    const det = { state: "needs-author-update" as const, reason: "too large", findings: [], checks, needsJudgment: false };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det });
    expect(verdict.nextAction).toBe("Consider splitting it (40 files, 4000 lines changed)");
  });
});

const MODEL_DET: DeterministicResult = {
  ...FOCUSED_DET,
  sources: { quality: [{ id: "docs", group: "code-vs-ci" }], custom: [], rules: [] },
};
const PLAN: QualityPlan = { docs: { changed: [], asked: { "docs-file-001": "src/a.ts" }, unread: [] } };

function noul(answers: Record<string, number>) {
  return parseAnswers(Object.entries(answers).map(([id, value]) => JSON.stringify({ id, type: "noul", noul: value })).join(""));
}

describe("verdict", () => {
  test.each<[string, Record<"pass" | "fail" | "cant_tell", number>, string, string]>([
    ["pass at 0.7", { pass: 0.7, fail: 0.2, cant_tell: 0.1 }, "pass", "ready-monitoring"],
    ["fail at 0.7", { pass: 0.2, fail: 0.7, cant_tell: 0.1 }, "fail", "needs-author-update"],
    ["unsure below both", { pass: 0.65, fail: 0.3, cant_tell: 0.05 }, "unsure", "awaiting-review"],
  ])("the verdict question decides %s, and its pass probability is the score", (_, choice, verdict, state) => {
    const rendered = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: MODEL_DET, answers: noul({ "docs-file-001": 0.2 }), plan: PLAN, choice });
    expect(rendered).toMatchObject({ verdict, state, score: choice.pass, degraded: null, mirror: true, reasons: [] });
  });

  test("a failed hard rule decides Fail without the verdict question, failed hard rules first among the reasons", () => {
    const checks = [{ check: "no-forbidden-paths", kind: "machine" as const, result: "fail" as const, reason: "touches forbidden paths", evidence: ["vendor/a.ts"], output: { kind: "values" as const, values: {} } }];
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...MODEL_DET, state: "needs-author-update", reason: "touches forbidden paths", checks, needsJudgment: false } });
    expect(verdict).toMatchObject({ verdict: "fail", state: "needs-author-update", score: null, degraded: null, reasons: ["touches forbidden paths: vendor/a.ts"] });
    expect(verdict.checks.at(-1)).toMatchObject({ check: "docs", result: "unconfirmed", reason: "not asked" });
  });

  test("a failed chunk degrades the verdict to unsure and keeps the answered checks", () => {
    const det: DeterministicResult = { ...MODEL_DET, sources: { ...MODEL_DET.sources!, custom: [{ id: "custom-1", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "Names a ticket." }] } };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det, answers: noul({ "docs-file-001": 0.8 }), plan: PLAN, judgeError: "upstream 503" });
    expect(verdict.checks.map(({ check, result }) => [check, result])).toEqual([["docs", "fail"], ["custom-1", "unconfirmed"]]);
    expect(verdict).toMatchObject({ verdict: "unsure", state: "awaiting-review", mirror: true, degraded: "inference-outage", reasons: ["documentation is not updated: src/a.ts"] });
    expect(verdict.feedback).toBe(`${UNSURE}@octocat, please address the following:\n- documentation is not updated for \`src/a.ts\`\n\n${OUTAGE_NOTE}`);
  });

  test("a closed pull request is not decided and gets no comment", () => {
    const findings = [{ check: "state", state: "ready-monitoring" as const, reason: "pull request is closed" }];
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...MODEL_DET, findings, checks: [], needsJudgment: false } });
    expect(verdict).toMatchObject({ verdict: "unsure", mirror: true, feedback: "" });
  });
});

describe("score and choose rules", () => {
  const levels = ["poor", "fair", "good", "great"];
  const pack: CheckPack = {
    ...emptyPack("acme/widgets"),
    custom: [
      { id: "style", name: "Style", group: "pull-request", kind: "model", shape: "score", subject: "style", levels },
      { id: "care", name: "Care", group: "pull-request", kind: "model", shape: "score", subject: "care", levels, failBelow: "good" },
      { id: "kind", name: "Kind", group: "pull-request", kind: "model", shape: "choose", options: ["fix", "feature", "chore"], failOn: ["chore"] },
    ],
  };
  const scored: DeterministicResult = { state: "ready-monitoring", reason: "all deterministic rules passed", findings: [], checks: [], needsJudgment: true, sources: classificationSources(pack) };

  function score(id: string, probabilities: number[]): string {
    const legend = Object.fromEntries(levels.map((level, index) => [String(index), level]));
    return JSON.stringify({ id, type: "score", score: 1, legend, probabilities: Object.fromEntries(probabilities.map((p, index) => [String(index), p])), confidence: 0.9 });
  }

  test("a score rule records its level, never fails without failBelow, and fails when the level is likely below it", () => {
    const kind = JSON.stringify({ id: "kind", type: "choice", choice: "chore", probabilities: { fix: 0.1, feature: 0.1, chore: 0.8 }, confidence: 0.9 });
    const answers = parseAnswers([score("style", [0.9, 0.1, 0, 0]), score("care", [0.5, 0.3, 0.2, 0]), kind].join("\n"));
    const checks = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: scored, answers }).checks;
    expect(checks.map((c) => [c.check, c.result, c.evidence])).toEqual([["style", "pass", ["poor"]], ["care", "fail", ["poor"]], ["kind", "fail", ["chore"]]]);
    expect(checks[1]!.output).toEqual({ kind: "level", level: "poor", levels, failBelow: "good" });
  });

  test("a score answer over other levels, or probabilities that do not sum to 1, is unanswered", () => {
    const style = JSON.stringify({ id: "style", type: "score", score: 1, legend: { 0: "bad", 1: "fair", 2: "good", 3: "great" }, probabilities: { 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 }, confidence: 0.5 });
    const care = JSON.stringify({ id: "care", type: "score", score: 1, legend: { 0: "poor", 1: "fair", 2: "good", 3: "great" }, probabilities: { 0: 0.9, 1: 0.9, 2: 0.9, 3: 0.9 }, confidence: 0.5 });
    const answers = parseAnswers([style, care, JSON.stringify({ id: "kind", type: "choice", choice: "fix", probabilities: { fix: 0.9, feature: 0.9, chore: 0.9 }, confidence: 1 })].join("\n"));
    const checks = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: scored, answers }).checks;
    expect(checks.map((c) => c.result)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
  });

  test("Jev's own score and choice reply reads by the levels its legend names", () => {
    // Recorded from OpenCode Zen jev-1.13 on 2026-10-13 for these two questions about a one-hunk fix.
    const reply = '{"id":"care","type":"score","score":1.9,"legend":{"0":"poor","1":"fair","2":"good","3":"great"},"probabilities":{"0":0.06,"1":0.24,"2":0.45,"3":0.25},"confidence":0.39}\n{"id":"kind","type":"choice","choice":"fix","probabilities":{"fix":1,"feature":0,"chore":0},"confidence":1}';
    const checks = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: scored, answers: parseAnswers(reply) }).checks;
    expect(checks.map((c) => [c.check, c.result, c.evidence])).toEqual([["style", "unconfirmed", []], ["care", "pass", ["good"]], ["kind", "pass", ["fix"]]]);
  });
});

describe("a policy without a decision-model rule", () => {
  const det = (checks: DeterministicResult["checks"]): DeterministicResult => ({ state: "ready-monitoring", reason: "all deterministic rules passed", findings: [], checks, needsJudgment: true, sources: { quality: [], custom: [] } });
  const ci = (result: "pass" | "unconfirmed") => ({ check: "ci-green", kind: "machine" as const, result, reason: "checks", evidence: [], output: { kind: "values" as const, values: {} } });

  test("passes without the model when every rule passes, and is unsure while CI is pending", () => {
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: det([ci("pass")]) })).toMatchObject({ verdict: "pass", score: null, reason: "every rule passed, and the policy has no decision-model rule" });
    expect(renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: det([ci("unconfirmed")]) })).toMatchObject({ verdict: "unsure", degraded: null, reason: "not every rule could be confirmed, and the policy has no decision-model rule" });
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
      { check: "ci-green", kind: "machine" as const, result: "fail" as const, reason: "required checks are failing", evidence: hostile },
      { check: "focused", kind: "model" as const, result: "fail" as const, reason: "unrelated changes", evidence: hostile },
    ];
    const verdict = renderVerdict({
      author: "octocat",
      repo: "acme/widgets",
      headSha: "abc123",
      det: { state: "blocked", reason: "required checks are failing", findings: [], checks, needsJudgment: false },
    });
    const lines = verdict.feedback.split("\n");
    expect(lines).toHaveLength(4 + hostile.length);
    for (const line of lines.slice(3)) {
      expect(line).toMatch(/^- /);
      const outside = line.replace(/(`+)(?:(?!\1)[\s\S])*?\1(?!`)/g, "");
      expect(outside).not.toMatch(/@|\]\(|<!--|[\u202e\u0007]/);
    }
  });
});

describe("requested changes rendering", () => {
  const review = { check: "no-changes-requested", kind: "machine", result: "fail", reason: "a reviewer requested changes", evidence: ["changes requested by @maya"] } as const;
  const conflicts = { check: "no-merge-conflicts", kind: "machine", result: "fail", reason: "merge conflicts with base", evidence: [] } as const;
  const det: DeterministicResult = {
    state: "needs-author-update",
    reason: "a reviewer requested changes",
    findings: [{ check: "no-changes-requested", state: "needs-author-update", reason: "a reviewer requested changes" }],
    checks: [review],
    needsJudgment: false,
    sources: { quality: [], custom: [], rules: [] },
  };

  test("posts nothing when the maintainer's review is the only reason, and still waits on the author", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det });
    expect(verdict).toMatchObject({ state: "needs-author-update", actor: "author", nextAction: "Address requested changes from @maya", feedback: "" });
  });

  test("hands an answered review back to the maintainer without a comment", () => {
    const answered = { ...review, reason: REVIEW_ANSWERED_REASON };
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...det, checks: [answered] } });
    expect(verdict).toMatchObject({ state: "needs-author-update", actor: "maintainer", nextAction: "Re-review: the author responded to changes requested by @maya", feedback: "" });
  });

  test("leaves the review out of a comment that has other reasons", () => {
    const verdict = renderVerdict({ author: "octocat", repo: "acme/widgets", headSha: "abc123", det: { ...det, checks: [review, conflicts] } });
    expect(verdict.feedback).toBe("**Triage: Fail**\n\n@octocat, please address the following:\n- merge conflicts with base");
  });
});
