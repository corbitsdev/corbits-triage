import { expect, test } from "bun:test";
import { type } from "arktype";
import { StageResult } from "./stage-result.js";

const REVIEW = { summary: "One bug.", comments: [{ path: "src/a.ts", start: 3, end: 4, title: "Off by one", body: "The loop skips the last item." }], budgetExhausted: false };
const VERDICT = { verdict: "pass", reasons: ["Every rule passed."] };

test("a stage result is read by its kind, and one whose result is not that kind's output is refused", () => {
  expect(StageResult({ kind: "code-review", head: "h1", result: REVIEW })).toEqual({ kind: "code-review", head: "h1", result: REVIEW });
  expect(StageResult({ kind: "judge", head: "h1", result: VERDICT })).toEqual({ kind: "judge", head: "h1", result: VERDICT });
  for (const malformed of [
    { kind: "code-review", head: "h1", result: VERDICT },
    { kind: "judge", head: "h1", result: { verdict: "maybe" } },
    { kind: "code-review", result: REVIEW },
    { kind: "lint", head: "h1", result: {} },
  ]) {
    expect(StageResult(malformed)).toBeInstanceOf(type.errors);
  }
});
