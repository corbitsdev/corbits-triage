import { expect, test } from "bun:test";
import type { PrFacts, PrFileFacts } from "./checks.js";
import { patchHunks } from "./hunks.js";
import { NO_FACTS } from "./item.js";
import { focusedPartRequests, MAX_SYSTEM_ONE_QUESTIONS, MAX_SYSTEM_ONE_STATE_BYTES, prepareQualityEvaluation, type JudgeRequest } from "./quality.js";

const SOURCES = { quality: [{ id: "focused" as const, group: "pull-request" as const }], custom: [], rules: [] };

function facts(files: PrFileFacts[]): PrFacts {
  return {
    ...NO_FACTS,
    repo: "acme/widgets",
    number: 8,
    title: "Réorganiser 設定",
    author: "octocat",
    headSha: "abc",
    state: "open",
    draft: false,
    mergeable: true,
    checks: "success",
    approvals: 0,
    files,
  };
}

function compactHunks(count: number, offset = 0): string {
  return Array.from({ length: count }, (_, index) => [
    `@@ -${index + 1} +${index + 1} @@`,
    `+const value${offset + index} = { name: "Hunk ${offset + index}" };`,
  ].join("\n")).join("\n");
}

function widePatch(): string {
  return Array.from({ length: 20 }, (_, index) => `@@ -${index + 1} +${index + 1} @@\n+// ${"設".repeat(3_000)}`).join("\n");
}

function withinBudget({ state, questions }: JudgeRequest): boolean {
  return questions.length <= MAX_SYSTEM_ONE_QUESTIONS && new TextEncoder().encode(JSON.stringify(state)).byteLength <= MAX_SYSTEM_ONE_STATE_BYTES;
}

test("quality preflight sends the pull request, its hunks and the docs, and asks focused once about the whole pull request", () => {
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
  expect(requests[0]!.questions.map(({ id, type }) => [id, type])).toEqual([["focused", "choice"]]);
  expect(requests[0]!.questions[0]!.instructions).toContain("one thing, or more than one thing");
});

test("quality preflight splits files in order across requests under the state budget and asks focused about each request's slice", () => {
  const sources = { ...SOURCES, quality: [...SOURCES.quality, { id: "docs" as const, group: "code-vs-ci" as const }] };
  const files = Array.from({ length: 30 }, (_, index) => ({
    path: `src/file${index}.ts`,
    patch: [`@@ -1 +1,40 @@`, `+export const file${index} = 1;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(12)}${line}`)].join("\n"),
  }));
  const evaluation = prepareQualityEvaluation(facts(files), sources);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.requests.length).toBeGreaterThan(1);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  const held = evaluation.requests.map((request) => request.state.pullRequest.files.map((file) => file.path));
  expect(held.flat()).toEqual(files.map((file) => file.path));
  expect(evaluation.requests.map((request) => request.questions.filter((question) => question.id.startsWith("focused-slice-")).map((question) => question.id))).toEqual(held.map((_, index) => [`focused-slice-${String(index + 1).padStart(3, "0")}`]));
  expect(evaluation.requests.flatMap((request) => request.questions.filter((question) => question.id.startsWith("docs-file-")).map((question) => question.type))).toEqual(files.map(() => "choice"));
  expect(Object.values(evaluation.focused!.slices)).toEqual(held);
  expect(evaluation.focused!.unread).toEqual([]);
  expect(prepareQualityEvaluation(facts(files), sources)).toEqual(evaluation);
});

test("quality preflight shows the whole-pull-request question every file of a wide pull request of small files", () => {
  const sources = { ...SOURCES, quality: [...SOURCES.quality, { id: "docs" as const, group: "code-vs-ci" as const }] };
  const files = Array.from({ length: 120 }, (_, index) => ({ path: `src/file${index}.ts`, patch: compactHunks(1, index) }));
  const evaluation = prepareQualityEvaluation(facts(files), sources);
  expect(evaluation.requests).toHaveLength(1);
  expect(evaluation.requests[0]!.state.pullRequest.files).toHaveLength(120);
  expect(evaluation.focused).toEqual({ slices: { focused: files.map((file) => file.path) }, unread: [], parts: {} });
});

test("quality preflight does not ask focused when only generated files changed", () => {
  const evaluation = prepareQualityEvaluation(facts([{ path: "bun.lock", patch: "@@ -1 +1 @@\n-a\n+b" }]), SOURCES);
  expect(evaluation).toEqual({ plan: {}, requests: [] });
});

test("quality preflight never lets the changed paths crowd out the diff, and says how large metadata over the budget is", () => {
  const sources = { ...SOURCES, quality: [...SOURCES.quality, { id: "docs" as const, group: "code-vs-ci" as const }] };
  const files = Array.from({ length: 3_000 }, (_, index) => ({ path: `packages/area-${index % 40}/src/module-${index}/file-${index}.ts`, additions: 1, deletions: 0, patch: compactHunks(1, index) }));
  const evaluation = prepareQualityEvaluation({ ...facts(files), paths: files.map((file) => file.path), docs: { "README.md": "d".repeat(24_000) } }, sources);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  const { paths, directories } = evaluation.requests[0]!.state.pullRequest;
  expect(paths.length).toBeLessThan(3_000);
  expect(new TextEncoder().encode(JSON.stringify(paths)).byteLength).toBeLessThanOrEqual(8 * 1024);
  expect(Object.values(directories!).reduce((total, row) => total + row.files, 0)).toBe(3_000);
  expect(new TextEncoder().encode(JSON.stringify(directories)).byteLength).toBeLessThanOrEqual(8 * 1024);
  expect(Object.values(evaluation.focused!.slices).flat()).toHaveLength(3_000);

  const tooLarge = prepareQualityEvaluation({ ...facts(files.slice(0, 1)), docs: { "README.md": "d".repeat(100_000) } }, SOURCES);
  expect(tooLarge).toMatchObject({ requests: [], judgeError: "pull request too large for the decision model (98 KB)" });
});

test("quality preflight shows focused a hunk too large for any request in pieces cut at line ends", () => {
  const lines = Array.from({ length: 1_500 }, (_, index) => `+const value${index} = "${"x".repeat(20)}";`);
  const patch = ["@@ -0,0 +1,1500 @@", ...lines].join("\n");
  const evaluation = prepareQualityEvaluation({ ...facts([{ path: "src/big.ts", status: "added", additions: 1_500, deletions: 0, patch }]), docs: { "README.md": "d".repeat(40_000) } }, SOURCES);
  expect(evaluation.requests.length).toBeGreaterThan(1);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  expect(evaluation.requests.flatMap((request) => request.state.pullRequest.files.flatMap((file) => file.hunks)).join("\n")).toBe(patch);
  expect(evaluation.focused!.unread).toEqual([]);
});

test("quality preflight lists only the changed paths that fit focused's share, with directories when any is left out", () => {
  const files = Array.from({ length: 100 }, (_, index) => ({ path: `src/${"nested/".repeat(30)}${index}.ts`, patch: compactHunks(1, index) }));
  const { paths, directories } = prepareQualityEvaluation({ ...facts(files), paths: files.map((file) => file.path) }, SOURCES).requests[0]!.state.pullRequest;
  expect(new TextEncoder().encode(JSON.stringify(paths)).byteLength).toBeLessThanOrEqual(8 * 1024);
  expect(Object.values(directories!).reduce((total, row) => total + row.files, 0)).toBe(100);
});

test("quality preflight refuses metadata that leaves too little room for files, and more requests than the cap, instead of asking thousands", () => {
  const patch = compactHunks(1);
  const subject = prepareQualityEvaluation({ ...facts([{ path: "src/a.ts", patch }]), commits: ["x".repeat(90_000)] }, SOURCES);
  expect(subject.requests[0]!.state.pullRequest.commits).toEqual(["x".repeat(200)]);
  const crowded = prepareQualityEvaluation({ ...facts([{ path: "src/a.ts", patch }]), docs: { "README.md": "d".repeat(85_000) } }, SOURCES);
  expect(crowded).toMatchObject({ requests: [], judgeError: expect.stringMatching(/^pull request too large for the decision model \(\d+ KB\)$/) });
  const wide = prepareQualityEvaluation(facts(Array.from({ length: 40 }, (_, index) => ({ path: `src/wide${index}.ts`, patch: widePatch() }))), SOURCES);
  expect(wide).toMatchObject({ requests: [], judgeError: expect.stringMatching(/^pull request too large for the decision model \(\d+ requests\)$/) });
});

test("quality preflight leaves a cut patch unread for focused even when its first hunk is read in pieces", () => {
  const patch = ["@@ -0,0 +1,60 @@", ...Array.from({ length: 60 }, () => `+// ${"設".repeat(1_000)}`)].join("\n");
  const { focused } = prepareQualityEvaluation(facts([{ path: "src/big.ts", additions: 60, deletions: 0, patch, patchTruncated: true }]), SOURCES);
  expect(focused!.unread).toEqual(["src/big.ts"]);
});

test("quality preflight leaves a cut patch unread for docs even when its read part fits", () => {
  const sources = { ...SOURCES, quality: [...SOURCES.quality, { id: "docs" as const, group: "code-vs-ci" as const }] };
  const { plan } = prepareQualityEvaluation(facts([{ path: "src/cut.ts", additions: 9_000, deletions: 0, patch: compactHunks(2), patchTruncated: true }]), sources);
  expect(plan.docs!.unread).toEqual(["src/cut.ts"]);
});

test("quality preflight asks docs about every part of a file too large for one request instead of leaving it unread", () => {
  const sources = { quality: [{ id: "docs" as const, group: "code-vs-ci" as const }], custom: [], rules: [] };
  const { plan, requests } = prepareQualityEvaluation(facts([{ path: "src/wide.ts", additions: 20, deletions: 0, patch: widePatch() }]), sources);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.every(withinBudget)).toBe(true);
  expect(requests.flatMap((request) => request.state.pullRequest.files.flatMap((file) => file.hunks))).toEqual(patchHunks(widePatch()));
  expect(requests.map((request) => request.questions.map((question) => question.id))).toEqual(requests.map((_, index) => [index === 0 ? "docs-file-001" : `docs-file-001-part-${String(index).padStart(3, "0")}`]));
  expect(Object.values(plan.docs!.asked)).toEqual(requests.map(() => "src/wide.ts"));
  expect(plan.docs!.unread).toEqual([]);
});

test("focused's follow-up asks a failing slice's request again, one question per file it holds, at most 30 in all", () => {
  const files = Array.from({ length: 60 }, (_, index) => ({
    path: `src/file${index}.ts`,
    patch: [`@@ -1 +1,40 @@`, `+export const file${index} = 1;`, ...Array.from({ length: 40 }, (_, line) => `+// ${"evidence ".repeat(12)}${line}`)].join("\n"),
  }));
  const { focused, requests } = prepareQualityEvaluation(facts(files), SOURCES);
  const [, second] = Object.keys(focused!.slices) as [string, string];
  const parts = focusedPartRequests(requests, [second]);
  expect(parts.requests.map((request) => request.state)).toEqual([requests[1]!.state]);
  expect(Object.values(parts.asked)).toEqual(focused!.slices[second]);
  expect(parts.requests[0]!.questions.map((question) => question.instructions)).toEqual(focused!.slices[second]!.map((_, index) => expect.stringContaining(`\`pullRequest.files[${index}]\``)));
  expect(Object.keys(focusedPartRequests(requests, Object.keys(focused!.slices)).asked)).toHaveLength(30);
});

test("focused's follow-up asks about a file split across failing slices once", () => {
  const { focused, requests } = prepareQualityEvaluation(facts([{ path: "src/wide.ts", patch: widePatch() }]), SOURCES);
  expect(requests.length).toBeGreaterThan(1);
  expect(Object.values(focusedPartRequests(requests, Object.keys(focused!.slices)).asked)).toEqual(["src/wide.ts"]);
});

test("quality preflight asks whole pull request questions in the first request and file questions with their file, splitting at the question cap", () => {
  const custom = Array.from({ length: 254 }, (_, index) => ({ id: `custom-${index + 1}`, name: `Check ${index + 1}`, group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "Keeps boundaries" }));
  const sources = {
    quality: [
      { id: "focused" as const, group: "pull-request" as const },
      { id: "docs" as const, group: "code-vs-ci" as const },
    ],
    custom,
  };
  const evaluation = prepareQualityEvaluation(facts([{ path: "src/a.ts", patch: compactHunks(2) }, { path: "src/b.ts", patch: compactHunks(2, 2) }]), sources);
  expect(evaluation.judgeError).toBeUndefined();
  const [first, second, ...rest] = evaluation.requests.map((request) => request.questions.map((question) => question.id));
  expect(first).toEqual([...custom.map((row) => row.id), "docs-file-001", "focused-slice-001"]);
  expect(second).toEqual(["docs-file-002", "focused-slice-002"]);
  expect(rest).toEqual([]);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  expect(evaluation.requests[1]!.state.pullRequest.files.map((file) => file.path)).toEqual(["src/b.ts"]);
});

test("quality preflight shows focused a file too large for one request in slices of its hunks", () => {
  const patch = widePatch();
  const evaluation = prepareQualityEvaluation(facts([{ path: "src/wide.ts", patch }]), SOURCES);
  expect(evaluation.judgeError).toBeUndefined();
  expect(evaluation.requests.length).toBeGreaterThan(1);
  expect(evaluation.requests.every(withinBudget)).toBe(true);
  const parts = evaluation.requests.map((request) => request.state.pullRequest.files[0]!);
  expect(parts.flatMap((part) => part.hunks)).toEqual(patchHunks(patch));
  expect(parts.slice(1).every((part) => part.continued)).toBe(true);
  expect(Object.keys(evaluation.focused!.slices)).toHaveLength(parts.length);
  expect(evaluation.focused!.unread).toEqual([]);
});

test("quality preflight gives the contribution rules only to requests that ask custom checks, in place of their copies in the docs", () => {
  const line = (path: string, size: number) => ({ path, patch: `@@ -0,0 +1 @@\n+${"x".repeat(size)}` });
  const rules = { "CONTRIBUTING.md": "Small commits.", "AGENTS.md": "y".repeat(8_000) };
  const reversible = { id: "custom-1", name: "Reversible", group: "code-vs-ci" as const, kind: "model" as const, shape: "is-true" as const, claim: "The migration can be rolled back.", scope: "file" as const, when: ["migrations/**"] };
  const { requests } = prepareQualityEvaluation(
    { ...facts([line("src/a.ts", 42_000), line("src/b.ts", 42_000), line("migrations/001.sql", 100)]), docs: { "README.md": "Run it.", "CONTRIBUTING.md": "Small commits." }, rules },
    { quality: [{ id: "docs", group: "pull-request" }], custom: [reversible], rules: [] },
  );
  expect(requests.every(withinBudget)).toBe(true);
  // Both large files share a request that the rules would not have left room for.
  expect(requests.map((request) => [request.state.pullRequest.files.map((file) => file.path), request.state.repository])).toEqual([
    [["src/a.ts", "src/b.ts"], { docs: { "README.md": "Run it.", "CONTRIBUTING.md": "Small commits." } }],
    [["migrations/001.sql"], { docs: { "README.md": "Run it." }, rules }],
  ]);
  expect(requests[1]!.questions.find((question) => question.id === "custom-1-file-003")?.instructions).toContain("`repository.rules`");
});
