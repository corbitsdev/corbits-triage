import { expect, test } from "bun:test";
import type { PrFacts, PrFileFacts } from "./checks.js";
import { focusedCandidateId, MAX_SYSTEM_ONE_QUESTIONS, MAX_SYSTEM_ONE_STATE_BYTES, prepareQualityEvaluation, type JudgeRequest } from "./quality.js";

const SOURCES = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [], rules: [] };

function facts(files: PrFileFacts[]): PrFacts {
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
    files,
  };
}

function compactHunks(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+const value${offset + index} = { name: "Candidate ${offset + index}" };`,
  ].join("\n")).join("\n");
}

function withinBudget({ state, questions }: JudgeRequest): boolean {
  return questions.length <= MAX_SYSTEM_ONE_QUESTIONS && new TextEncoder().encode(JSON.stringify(state)).byteLength <= MAX_SYSTEM_ONE_STATE_BYTES;
}

function askedIds(requests: JudgeRequest[]): string[] {
  return requests.flatMap((request) => request.questions.map((question) => question.id));
}

test("quality preflight sends the pull request, its hunks and the docs, and points each candidate at its hunk", () => {
  const patch = '@@ -0,0 +1 @@\n+const config = { name: "Visible 設定" };';
  const { requests, judgeError } = prepareQualityEvaluation({
    ...facts([{ path: "bun.lock", patch: "@@ -1 +1 @@\n-a\n+b" }, { path: "src/config.ts", status: "modified", patch }]),
    body: "Moves config",
    commits: ["refactor: move config"],
    paths: ["bun.lock", "src/config.ts"],
    docs: { "README.md": "Run it." },
  }, SOURCES);
  expect(judgeError).toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.state).toEqual({
    pullRequest: {
      title: "Réorganiser 設定",
      body: "Moves config",
      commits: ["refactor: move config"],
      paths: ["bun.lock", "src/config.ts"],
      files: [{ path: "src/config.ts", status: "modified", hunks: [patch] }],
    },
    repository: { docs: { "README.md": "Run it." } },
  });
  expect(requests[0]!.questions.map(({ id }) => id)).toEqual(["focused-candidate-001"]);
  expect(requests[0]!.questions[0]!.instructions).toContain("`pullRequest.files[0].hunks[0]` (Visible 設定)");
});

test("quality preflight splits files in order across requests under the state budget and asks every candidate once against its own file", () => {
  const files = Array.from({ length: 30 }, (_, index) => ({
    path: `src/file${index}.ts`,
    patch: [`@@ -1 +1,40 @@`, `+export const file${index} = 1;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(12)}${line}`)].join("\n"),
  }));
  const evaluation = prepareQualityEvaluation(facts(files), SOURCES);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.requests.length).toBeGreaterThan(1);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  expect(evaluation.requests.flatMap((request) => request.state.pullRequest.files.map((file) => file.path))).toEqual(files.map((file) => file.path));
  expect(askedIds(evaluation.requests)).toEqual(files.map((_, index) => focusedCandidateId(index)));
  for (const { state, questions } of evaluation.requests) {
    for (const question of questions) {
      const candidate = evaluation.candidates[Number(question.id.slice(-3)) - 1]!;
      const file = state.pullRequest.files.findIndex((f) => f.path === candidate.path);
      expect(question.instructions).toContain(`pullRequest.files[${file}].hunks[0]`);
    }
  }
  expect(prepareQualityEvaluation(facts(files), SOURCES)).toEqual(evaluation);
});

test("quality preflight asks every non-candidate question in the first request and splits candidates at the question cap", () => {
  const custom = Array.from({ length: 57 }, (_, index) => ({ id: `custom-${index + 1}`, name: `Check ${index + 1}`, group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }));
  const sources = {
    quality: [
      { id: "focused" as const, group: "pull-request" as const },
      { id: "docs" as const, group: "code-vs-ci" as const },
      { id: "tests" as const, group: "code-vs-ci" as const },
    ],
    custom,
  };
  const evaluation = prepareQualityEvaluation(facts([{ path: "src/a.ts", patch: compactHunks(150) }, { path: "src/b.ts", patch: compactHunks(50, 150) }]), sources);
  expect(evaluation.judgeError).toBeUndefined();
  const [first, second, ...rest] = evaluation.requests.map((request) => request.questions.map((question) => question.id));
  expect(first).toEqual(["docs", "tests", ...custom.map((row) => row.id), ...Array.from({ length: 150 }, (_, index) => focusedCandidateId(index))]);
  expect(second).toEqual(Array.from({ length: 50 }, (_, index) => focusedCandidateId(150 + index)));
  expect(rest).toEqual([]);
  expect(evaluation.requests[1]!.state.pullRequest.files.map((file) => file.path)).toEqual(["src/b.ts"]);
});

test("quality preflight keeps the leading hunks of a file too large for one request and leaves the rest without evidence", () => {
  const patch = Array.from({ length: 20 }, (_, index) => `@@ -${index + 1} +${index + 1} @@\n+// ${"設".repeat(3_000)}`).join("\n");
  const evaluation = prepareQualityEvaluation(facts([{ path: "src/wide.ts", patch }]), SOURCES);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.requests).toHaveLength(1);
  const [request] = evaluation.requests as [JudgeRequest];
  expect(withinBudget(request)).toBe(true);
  const [file] = request.state.pullRequest.files;
  expect(file?.truncated).toBe(true);
  const kept = file!.hunks.length;
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(20);
  expect(file!.hunks).toEqual(evaluation.candidates.slice(0, kept).map((candidate) => candidate.evidence));
  expect(evaluation.candidates.slice(kept).every((candidate) => candidate.evidence === "")).toBe(true);
  expect(askedIds(evaluation.requests)).toEqual(Array.from({ length: kept }, (_, index) => focusedCandidateId(index)));
});
