import { expect, test } from "bun:test";
import type { WorkflowRunEvent } from "@intx/hub-sessions";
import { verdictFor } from "./triage-runs.js";

const REPO = "acme/widgets";

function completed(seq: number, stepId: string, output: unknown): WorkflowRunEvent {
  return { seq, type: "StepCompleted", body: { type: "StepCompleted", seq, at: "2026-10-20T00:00:00.000Z", stepId, output: { ref: `inline:${JSON.stringify(output)}` } } } as WorkflowRunEvent;
}

test("a Do the PR workflow's execute held after code review waits for a maintainer as one triage held", () => {
  const approve = { list: "pass", index: 0, kind: "approve", effectId: "e1", target: {}, reason: "passes the repository's policy" };
  const events = [
    completed(1, "evaluate", { repo: REPO, number: 8, headSha: "abc", actions: [approve] }),
    completed(2, "execute", { dos: [{ effectId: "e1", status: "held", error: "Code review is findings; a maintainer decides." }] }),
  ];
  expect(verdictFor(events, REPO, 8)?.["actions"]).toEqual([{ ...approve, held: true, reason: "Code review is findings; a maintainer decides." }]);
});
