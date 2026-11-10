import { expect, test } from "bun:test";
import type { EffectContext } from "@intx/workflow";
import type { TakeOutput } from "./manager.js";
import { postReview } from "./review.js";
import { manageMail } from "./hub.js";

const FINDING = { path: "a.ts", start: 11, end: 11, title: "Same bug", body: "Same cause and trigger", priority: 2, thread: { id: 501, state: "untouched" as const } };
const RESULT = { summary: "No new defects.", complete: true, budgetExhausted: false, comments: [FINDING] };
const OLD = { kind: "code-review", head: "old", runId: "old_run", deployedBy: "manager", deadline: "2026-01-01", result: RESULT };
const TAKE: TakeOutput = { run: true, triage: true, approvals: [], overdue: false, head: "new", taken: {}, reviewers: [OLD], review: RESULT, reviewRun: "new_run" };
const NO_WRITES = { perform() { throw new Error("a repeated finding must not write to the host"); } } as unknown as EffectContext;

for (const source of ["github", "bitbucket-datacenter"] as const) {
  const payload = { headers: { to: ["manager@acme.test"] }, parts: [{ contentType: "text/plain", text: manageMail("tnt_acme", { source, repo: "acme/widgets", number: 1 }) }] };
  test(`${source}: repeated findings keep their original thread without another host write`, async () => {
    const input = { payload, take: { output: TAKE }, reviewScope: { output: { reviewed: true } } };
    expect(await postReview(input, NO_WRITES, new AbortController().signal)).toEqual({ posted: true, threads: { runId: "new_run", ids: [501] } });
  });
  test(`${source}: neither a new nor a stored report can validate its own thread IDs`, async () => {
    const current = { ...OLD, head: "new", runId: "new_run" };
    for (const stored of [false, true]) {
      for (const commentThreads of [[], [{ runId: "new_run", threads: [FINDING.thread] }]]) {
        const take = { ...TAKE, reviewers: [current], commentThreads };
        if (stored) {
          delete take.review;
          delete take.reviewRun;
        }
        let calls = 0;
        const ctx = { perform() { calls++; return { content: { threads: [777] } }; } } as unknown as EffectContext;
        const input = { payload, take: { output: take }, reviewScope: { output: { reviewed: true } } };
        expect(await postReview(input, ctx, new AbortController().signal)).toEqual({ posted: true, threads: { runId: "new_run", ids: [777] } });
        expect(calls).toBe(1);
      }
    }
  });
  test(`${source}: an unrecognized thread cannot suppress a new finding`, async () => {
    const review = { ...RESULT, comments: [{ ...FINDING, thread: { id: 999, state: "resolved" } }] };
    const input = { payload, take: { output: { ...TAKE, review } }, reviewScope: { output: { reviewed: true } } };
    const ctx = { perform() { return { content: { threads: [777] } }; } } as unknown as EffectContext;
    expect(await postReview(input, ctx, new AbortController().signal)).toEqual({ posted: true, threads: { runId: "new_run", ids: [777] } });
  });
  test(`${source}: duplicate-only reviews still publish incomplete and budget warnings`, async () => {
    for (const status of [{ complete: false }, { budgetExhausted: true }]) {
      let calls = 0;
      const ctx = { perform() { calls++; return { content: { threads: [] } }; } } as unknown as EffectContext;
      const take = { ...TAKE, review: { ...RESULT, ...status } };
      expect(await postReview({ payload, take: { output: take }, reviewScope: { output: { reviewed: true } } }, ctx, new AbortController().signal)).toEqual({ posted: true, threads: { runId: "new_run", ids: [501] } });
      expect(calls).toBe(1);
    }
  });
}
