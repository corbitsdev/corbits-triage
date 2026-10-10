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

function withinBudget({ questions, measurements }: { questions: unknown[]; measurements: { contextBytes: number; requestContentBytes: number } }): boolean {
  return questions.length <= MAX_SYSTEM_ONE_QUESTIONS &&
    measurements.contextBytes <= MAX_SYSTEM_ONE_CONTEXT_BYTES &&
    measurements.requestContentBytes <= MAX_SYSTEM_ONE_REQUEST_CONTENT_BYTES;
}

function askedIds(requests: Array<{ questions: Array<{ id: string }> }>): string[] {
  return requests.flatMap((request) => request.questions.map((question) => question.id));
}

test("quality preflight measures exact UTF-8 context and request bytes under budget", () => {
  const { requests, judgeError } = prepareQualityEvaluation(facts('@@ -0,0 +1 @@\n+const config = { name: "Visible 設定" };'), SOURCES);
  expect(requests).toHaveLength(1);
  const [{ state, questions, measurements }] = requests as [typeof requests[number]];
  const encoder = new TextEncoder();
  const stateBytes = encoder.encode(JSON.stringify(state)).byteLength;
  const longestQuestionBytes = Math.max(...questions.map((question) => encoder.encode(JSON.stringify(question)).byteLength));
  expect(measurements).toEqual({
    contextBytes: stateBytes + longestQuestionBytes,
    requestContentBytes: encoder.encode(JSON.stringify({ state, questions })).byteLength,
  });
  expect(withinBudget(requests[0]!)).toBe(true);
  expect(judgeError).toBeUndefined();
});

test("quality preflight splits the max-candidate evaluation into requests under budget that ask every candidate once, in order", () => {
  const evaluation = prepareQualityEvaluation(facts(maxCandidatePatch()), SOURCES);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.candidates).toHaveLength(200);
  expect(evaluation.requests.length).toBeGreaterThan(1);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  expect(askedIds(evaluation.requests)).toEqual(evaluation.candidates.map((_, index) => `focused-candidate-${String(index + 1).padStart(3, "0")}`));
  expect(prepareQualityEvaluation(facts(maxCandidatePatch()), SOURCES)).toEqual(evaluation);
});

test("quality preflight asks every non-candidate question in the first request and the remaining candidates after it", () => {
  const evaluation = prepareQualityEvaluation(facts(compactCandidatePatch(30)), MIXED_SOURCES);
  expect(evaluation.judgeError).toBeUndefined();
  const [first, second, ...rest] = evaluation.requests.map((request) => request.questions.map((question) => question.id));
  expect(first).toHaveLength(MAX_SYSTEM_ONE_QUESTIONS);
  expect(first!.slice(0, 4)).toEqual(["docs", "tests", "custom-1", "focused-candidate-001"]);
  expect(second).toEqual(["focused-candidate-030"]);
  expect(rest).toEqual([]);
});

test("quality preflight cuts a candidate too large to ask alone on line boundaries and marks it trimmed", () => {
  const paths = Array.from({ length: 200 }, (_, index) => `src/${"deep/".repeat(23)}${index}.ts`);
  const patch = ["@@ -0,0 +1,80 @@", '+const config = { name: "Large" };', ...Array.from({ length: 80 }, (_, line) => `+// ${"evidence".repeat(6)} ${line}`)].join("\n");
  const evaluation = prepareQualityEvaluation({ ...facts(patch), paths }, SOURCES);
  const [candidate] = evaluation.candidates;
  expect(candidate?.trimmed).toBe(true);
  expect(patch.startsWith(candidate!.evidence)).toBe(true);
  expect(patch[candidate!.evidence.length]).toBe("\n");
  expect(evaluation.requests).toHaveLength(1);
  expect(withinBudget(evaluation.requests[0]!)).toBe(true);
});

test("quality preflight refuses only when the metadata and non-candidate questions do not fit alone", () => {
  const paths = Array.from({ length: 100 }, (_, index) => `src/${"nested/".repeat(60)}${index}.ts`);
  const evaluation = prepareQualityEvaluation({ ...facts(""), paths }, SOURCES);
  expect(evaluation).toMatchObject({ requests: [], judgeError: "pull request too large for the decision model" });
});
