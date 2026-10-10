import { expect, test } from "bun:test";
import { previewEvaluation } from "./preview.js";
import type { PrFacts } from "../packages/triage-workflows/src/logic/checks.js";

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
