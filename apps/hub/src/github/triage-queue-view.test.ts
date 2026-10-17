import { expect, test } from "bun:test";
import { TriageQueue, createTriageQueueView } from "./triage-queue-view.js";

const NOW = new Date("2026-10-14T12:00:10Z");
const member = { tenantId: "t1", principalId: "p" };

test("the queue route lists the workspace's waiting and running jobs with their ages", async () => {
  const job = { repo: "acme/widgets", number: 7, headSha: "abc", source: "retry" as const, workflow: "pr-triage-github" };
  const handle = createTriageQueueView({
    coordinator: {
      snapshot(tenantId) {
        expect(tenantId).toBe("t1");
        return {
          queued: [{ ...job, queuedAt: "2026-10-14T12:00:00Z" }],
          running: [{ ...job, number: 8, source: "event", queuedAt: "2026-10-14T12:00:04Z", startedAt: "2026-10-14T12:00:05Z", runId: "run_1" }],
        };
      },
    },
    now: () => NOW,
  });
  const body = TriageQueue.assert(await (await handle(member)).json());
  expect(body).toMatchObject({ queued: [{ number: 7, ageMs: 10_000 }], running: [{ number: 8, ageMs: 6_000, runId: "run_1" }] });
});
