import { expect, test } from "bun:test";
import type { TakeOutput } from "./actions/manager.js";
import { previousReviewOf } from "./review-history.js";

const COMMENT = { path: "a.ts", start: 1, end: 1, title: "Bug", body: "Why", priority: 2 };
const OLD = { kind: "code-review", head: "old", runId: "run_old", deployedBy: "manager", deadline: "2026-01-01", result: { summary: "", comments: [COMMENT], complete: true, budgetExhausted: false } };
const TAKE: TakeOutput = { run: true, triage: true, approvals: [], overdue: false, reviewers: [OLD], commentThreads: [{ runId: OLD.runId, threads: [{ id: 501, state: "resolved" }] }] };

test("history joins posted thread IDs and retains findings across a later clean review", () => {
  expect(previousReviewOf(TAKE)).toMatchObject({ head: "old", comments: [{ thread: { id: 501, state: "resolved" } }] });
  const clean = { ...OLD, head: "fixed", runId: "run_fixed", deadline: "2026-01-02", result: { ...OLD.result, comments: [] } };
  expect(previousReviewOf({ ...TAKE, reviewers: [OLD, clean] })).toEqual({ head: "fixed", comments: [{ ...COMMENT, thread: { id: 501, state: "resolved" } }] });
  expect(previousReviewOf({ ...TAKE, reviewers: [OLD, clean] }, clean.runId)).toMatchObject({ head: "old", comments: [COMMENT] });
});

test("reviews with no posted findings need no history or old checkout", () => {
  expect(previousReviewOf({ ...TAKE, commentThreads: [] })).toBeUndefined();
});

test("later findings replace the same thread, while unrelated resolved findings survive", () => {
  const other = { ...COMMENT, thread: { id: 502, state: "resolved" as const } };
  const later = { ...OLD, head: "later", runId: "run_later", deadline: "2026-01-02", result: { ...OLD.result, comments: [{ ...COMMENT, title: "Updated description", thread: { id: 501, state: "replied" as const } }] } };
  const old = { ...OLD, result: { ...OLD.result, comments: [{ ...COMMENT, thread: { id: 501, state: "resolved" as const } }, other] } };
  expect(previousReviewOf({ ...TAKE, commentThreads: [], reviewers: [later, old] })).toEqual({ head: "later", comments: [later.result.comments[0], other] });
});
