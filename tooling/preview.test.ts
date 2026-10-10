import { expect, test } from "bun:test";
import { previewEvaluation, previewJudge } from "./preview.js";
import type { PrFacts } from "../packages/triage-workflows/src/logic/checks.js";
import { prepareQualityEvaluation } from "../packages/triage-workflows/src/logic/quality.js";

test("preview builds the same focused candidate questions and state as production", () => {
  const facts: PrFacts = {
    repo: "acme/widgets",
    number: 8,
    title: "Refactor",
    author: "octocat",
    tier: "external",
    headSha: "abc",
    state: "open",
    draft: false,
    mergeable: true,
    baseBehindBy: 0,
    checks: "success",
    requestedReviewers: 0,
    approvals: 0,
    openPrs: [],
    files: [{
      path: "src/config.ts",
      previousPath: "src/old-config.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-const config = {};\n+const config = { name: \"Visible label\" };",
    }],
  };
  const det = {
    state: "ready-monitoring" as const,
    reason: "all configured checks pass",
    findings: [],
    checks: [],
    duplicateOf: null,
    needsJudgment: true,
    sources: { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] },
  };

  const evaluation = previewEvaluation(facts, det);
  expect(evaluation.candidates).toMatchObject([{ path: "src/config.ts", previousPath: "src/old-config.ts", status: "renamed", label: "Visible label" }]);
  expect(evaluation.questions).toMatchObject([{ id: "focused-candidate-001", type: "choice" }]);
  expect("changeCandidates" in evaluation.state).toBe(true);
  if ("changeCandidates" in evaluation.state) {
    expect(evaluation.state.changeCandidates).toEqual({ "focused-candidate-001": evaluation.candidates[0] });
  }
});

test("preview delegates oversized evaluation preflight without dropping candidates", () => {
  const patch = Array.from({ length: 200 }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+// ${"evidence".repeat(27)}`,
    `+const value${index} = { name: "Candidate ${index}" };`,
  ].join("\n")).join("\n");
  const facts: PrFacts = {
    repo: "acme/widgets", number: 8, title: "Large", author: "octocat", tier: "external", headSha: "abc", state: "open", draft: false,
    mergeable: true, baseBehindBy: 0, checks: "success", requestedReviewers: 0, approvals: 0, openPrs: [],
    files: [{ path: "src/config.ts", patch }],
  };
  const det = {
    state: "ready-monitoring" as const, reason: "all configured checks pass", findings: [], checks: [], duplicateOf: null,
    needsJudgment: true, sources: { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] },
  };
  const preview = previewEvaluation(facts, det);
  const shared = prepareQualityEvaluation(facts, det.sources);
  expect(preview).toEqual(shared);
  expect(preview.candidates).toHaveLength(200);
  expect(preview.questions).toHaveLength(200);
  expect(preview.judgeError).toBe("quality evaluation exceeds the safe System One byte budget");
});

test("preview rejects 33 mixed questions before evaluate with shared parity", async () => {
  const patch = Array.from({ length: 30 }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+const value${index} = { name: "Candidate ${index}" };`,
  ].join("\n")).join("\n");
  const facts: PrFacts = {
    repo: "acme/widgets", number: 8, title: "Mixed", author: "octocat", tier: "external", headSha: "abc", state: "open", draft: false,
    mergeable: true, baseBehindBy: 0, checks: "success", requestedReviewers: 0, approvals: 0, openPrs: [],
    files: [{ path: "src/config.ts", patch }],
  };
  const sources = {
    quality: [
      { id: "focused" as const, group: "pull-request" as const },
      { id: "docs" as const, group: "code-vs-ci" as const },
      { id: "tests" as const, group: "code-vs-ci" as const },
    ],
    custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }],
  };
  const det = { state: "ready-monitoring" as const, reason: "pass", findings: [], checks: [], duplicateOf: null, needsJudgment: true, sources };
  const preview = previewEvaluation(facts, det);
  expect(preview).toEqual(prepareQualityEvaluation(facts, sources));
  expect(preview.questions).toHaveLength(33);
  let evaluated = 0;
  const result = await previewJudge(det, preview, async function neverEvaluate() {
    evaluated++;
    throw new Error("evaluate must not run");
  }, true);
  expect(evaluated).toBe(0);
  expect(result).toEqual({ judgeError: "quality evaluation exceeds the safe System One byte budget", judgeLimitExceeded: true });
});
