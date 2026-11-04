import { expect, test } from "bun:test";
import { createObservability, type ReviewEvent } from "./observability.js";

const EVENT: ReviewEvent = { msg: "reviewer_result_accepted_failure", tenantId: "tenant", source: "github", repo: "acme/widgets", number: 7, head: "abc", runId: "reviewer", managerRunId: "manager", kind: "code-review" };
const SECRET = "SENTINEL_credentials_prompt_source_exception";

function capture(events: ReviewEvent[]) {
  return async function send(event: ReviewEvent): Promise<void> { events.push(event); };
}

test("external projection routes only known events to distinct roles, never raw payloads or templates", async () => {
  const telemetry: ReviewEvent[] = [], errors: ReviewEvent[] = [], notifications: ReviewEvent[] = [];
  const obs = createObservability({ telemetry: [capture(telemetry)], errors: [capture(errors)], notifications: [capture(notifications)] });
  obs.observe({ ...EVENT, error: new Error(SECRET), message: SECRET, result: { summary: SECRET }, token: SECRET, mail: SECRET });
  obs.observe({ ...EVENT, msg: "reviewer_result_duplicate", failed: SECRET });
  obs.observe({ ...EVENT, msg: "reviewer_result_unrouted" });
  obs.observe({ ...EVENT, msg: SECRET });
  obs.observe({ ...EVENT, source: "invalid", error: SECRET });
  await obs.shutdown();
  expect(telemetry.map((event) => event.msg)).toEqual([EVENT.msg, "reviewer_result_duplicate", "reviewer_result_unrouted"]);
  expect(errors).toEqual([EVENT]);
  expect(notifications).toEqual([EVENT, { ...EVENT, msg: "reviewer_result_unrouted" }]);
  expect(JSON.stringify({ telemetry, errors, notifications })).not.toContain(SECRET);
  obs.observe(EVENT);
  expect(telemetry).toHaveLength(3);
});
