import { expect, test } from "bun:test";
import type { PrFacts } from "./checks.js";
import {
  MAX_SYSTEM_ONE_QUESTIONS,
  MAX_SYSTEM_ONE_CONTEXT_BYTES,
  MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES,
  prepareQualityEvaluation,
} from "./quality.js";

const SOURCES = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [] };

function facts(patch: string): PrFacts {
  return {
    repo: "acme/widgets",
    number: 8,
    title: "Réorganiser 設定",
    author: "octocat",
    headSha: "abc",
    state: "open",
    draft: false,
    mergeable: true,
    baseBehindBy: 0,
    checks: "success",
    requestedReviewers: 0,
    approvals: 0,
    openPrs: [],
    files: [{ path: "src/config.ts", patch }],
  };
}

function maxCandidatePatch(): string {
  return Array.from({ length: 200 }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+// ${"evidence".repeat(27)}`,
    `+const value${index} = { name: "Candidate ${index}" };`,
  ].join("\n")).join("\n");
}

function compactCandidatePatch(count: number): string {
  return Array.from({ length: count }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+const value${index} = { name: "Candidate ${index}" };`,
  ].join("\n")).join("\n");
}

const MIXED_SOURCES = {
  quality: [
    { id: "focused" as const, group: "pull-request" as const },
    { id: "docs" as const, group: "code-vs-ci" as const },
    { id: "tests" as const, group: "code-vs-ci" as const },
  ],
  custom: [{ id: "custom-1", name: "Architecture", group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }],
};

test("quality preflight measures exact UTF-8 context and request bytes under budget", () => {
  const evaluation = prepareQualityEvaluation(facts('@@ -0,0 +1 @@\n+const config = { name: "Visible 設定" };'), SOURCES);
  const encoder = new TextEncoder();
  const stateBytes = encoder.encode(JSON.stringify(evaluation.state)).byteLength;
  const longestQuestionBytes = Math.max(...evaluation.questions.map((question) => encoder.encode(JSON.stringify(question)).byteLength));
  expect(evaluation.measurements).toEqual({
    contextBytes: stateBytes + longestQuestionBytes,
    requestContentBytes: encoder.encode(JSON.stringify({ state: evaluation.state, questions: evaluation.questions })).byteLength,
  });
  expect(evaluation.measurements.contextBytes).toBeLessThanOrEqual(MAX_SYSTEM_ONE_CONTEXT_BYTES);
  expect(evaluation.measurements.requestContentBytes).toBeLessThanOrEqual(MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES);
  expect(evaluation.judgeError).toBeUndefined();
});

test("quality preflight rejects the complete max-candidate evaluation without sending a fitting prefix", () => {
  const evaluation = prepareQualityEvaluation(facts(maxCandidatePatch()), SOURCES);
  expect(evaluation.candidates).toHaveLength(200);
  expect(evaluation.questions).toHaveLength(200);
  expect(evaluation.questions.at(-1)?.id).toBe("focused-candidate-200");
  expect(evaluation.measurements.contextBytes > MAX_SYSTEM_ONE_CONTEXT_BYTES ||
    evaluation.measurements.requestContentBytes > MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES).toBe(true);
  expect(evaluation.judgeError).toBe("quality evaluation exceeds the safe System One byte budget");
});

test("quality preflight accepts exactly 32 mixed questions and rejects all 33 without taking a prefix", () => {
  const accepted = prepareQualityEvaluation(facts(compactCandidatePatch(29)), MIXED_SOURCES);
  expect(accepted.questions).toHaveLength(MAX_SYSTEM_ONE_QUESTIONS);
  expect(accepted.questions.at(-1)?.id).toBe("custom-1");
  expect(accepted.judgeError).toBeUndefined();

  const rejected = prepareQualityEvaluation(facts(compactCandidatePatch(30)), MIXED_SOURCES);
  expect(rejected.candidates).toHaveLength(30);
  expect(rejected.questions).toHaveLength(33);
  expect(rejected.questions.at(-1)?.id).toBe("custom-1");
  expect(rejected.measurements.contextBytes).toBeLessThanOrEqual(MAX_SYSTEM_ONE_CONTEXT_BYTES);
  expect(rejected.measurements.requestContentBytes).toBeLessThanOrEqual(MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES);
  expect(rejected.judgeError).toBe("quality evaluation exceeds the safe System One byte budget");
});
