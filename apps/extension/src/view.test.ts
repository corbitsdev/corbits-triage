import { expect, test } from "bun:test";
import { statusOf, type TriageView } from "./view.ts";

test("a run that failed shows Could not run, never the result stored from an older head", () => {
  const passed: TriageView = { pr: { repo: "o/r", number: 1 }, headSha: "a", ranAt: "2026-10-22T00:00:00Z", policy: { path: ".corbits-triage.yml", url: "" }, checks: [], notes: [], codeReview: { review: null } };
  expect(statusOf(passed, { running: false, error: "github.com did not answer.", at: "2026-10-22T00:01:00Z" })).toEqual({ text: "Could not run", tone: "unknown" });
});
