import { expect, test } from "bun:test";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { verdictFor } from "./triage-runs.js";

function completed(seq: number, stepId: string, output: unknown): WorkflowRunEvent {
  return { seq, type: "StepCompleted", body: { type: "StepCompleted", seq, at: "2026-10-20T00:00:00.000Z", stepId, output: { ref: `inline:${JSON.stringify(output)}` } } } as WorkflowRunEvent;
}

test("the hub reads a PR workflow run's Dos from decide: those it made, then evaluate's it left held for a maintainer", () => {
  const approve = { list: "pass", index: 0, kind: "approve", effectId: "e1", target: {} };
  const comment = { list: "pass", index: 1, kind: "comment", effectId: "e2", target: {} };
  const labels = { list: "pass", index: 2, kind: "labels", effectId: "e3", target: {} };
  const flagged = "Flagged for a maintainer: code-review is incomplete.";
  const verdict = { repo: "acme/widgets", number: 8, headSha: "abc", verdict: "pass" };
  const events = [
    completed(1, "evaluate", { ...verdict, actions: [approve, comment] }),
    completed(2, "decide", { decision: { flag: "code-review is incomplete" }, verdict: { ...verdict, actions: [labels] }, held: [{ effectId: "e1", status: "held", error: flagged }] }),
    completed(3, "execute", { dos: [{ effectId: "e3", status: "done" }, { effectId: "e1", status: "held", error: flagged }] }),
  ];
  expect(verdictFor(events, "acme/widgets", 8)?.["actions"]).toEqual([{ ...labels, status: "done" }, { ...approve, held: true, reason: flagged }]);
});
