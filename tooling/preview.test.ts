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
  const [request] = evaluation.requests;
  expect(request?.questions).toMatchObject([{ id: "focused-candidate-001", type: "choice" }]);
  expect(request?.state).toMatchObject({ changeCandidates: { "focused-candidate-001": evaluation.candidates[0] } });
});

test("preview refuses an evaluation whose metadata alone is over the budget before evaluate, with shared parity", async () => {
  const facts: PrFacts = {
    repo: "acme/widgets", number: 8, title: "Large", author: "octocat", tier: "external", headSha: "abc", state: "open", draft: false,
    mergeable: true, baseBehindBy: 0, checks: "success", requestedReviewers: 0, approvals: 0, openPrs: [],
    paths: Array.from({ length: 100 }, (_, index) => `src/${"nested/".repeat(60)}${index}.ts`),
  };
  const det = {
    state: "ready-monitoring" as const, reason: "all configured checks pass", findings: [], checks: [], duplicateOf: null,
    needsJudgment: true, sources: { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] },
  };
  const preview = previewEvaluation(facts, det);
  expect(preview).toEqual(prepareQualityEvaluation(facts, det.sources));
  let evaluated = 0;
  const result = await previewJudge(det, preview, async function neverEvaluate() {
    evaluated++;
    throw new Error("evaluate must not run");
  }, true);
  expect(evaluated).toBe(0);
  expect(result).toEqual({ judgeError: "pull request too large for the decision model", judgeLimitExceeded: true });
});
