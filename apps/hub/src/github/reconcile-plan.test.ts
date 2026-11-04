import { expect, test } from "bun:test";
import type { PrTriageRow } from "@corbits/triage-contracts";
import { DEFAULT_RECONCILE_POLICY, planTenant, runKey, type ObservedRun, type OpenPr } from "./reconcile-plan.js";

const MINUTE = 60_000;
const T0 = new Date("2026-10-07T00:00:00.000Z");
const REPO = "acme/widgets";

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MINUTE);
}

function run(runId: string, status: ObservedRun["status"], startedMinute: number): ObservedRun {
  return { runId, source: "github", status, startedAt: at(startedMinute).toISOString() };
}

test("after Triage again on a head that has a verdict, the next pass reports the maintainer's running run, not the old verdict", () => {
  const pr: OpenPr = { number: 8, headSha: "sha8", updatedAt: at(-1_000).toISOString(), draft: false };
  // The route's write on top of a triaged row: queued, queuedAt now, runId kept.
  const requeued: PrTriageRow = { number: 8, headSha: "sha8", status: "queued", attempts: 0, runId: "run-old", firstSeenAt: at(-120).toISOString(), queuedAt: at(-1).toISOString(), updatedAt: at(-1).toISOString() };
  const runs = new Map([[REPO, new Map([[runKey(8, "sha8"), [run("run-old", "completed", -60), run("run-new", "running", 0)]]])]]);
  const plan = planTenant({ repos: [{ name: REPO, prs: [pr], rows: [requeued] }], runs, roomless: new Set(), now: at(0), policy: DEFAULT_RECONCILE_POLICY }).get(REPO)!;
  expect(plan.rows[0]).toMatchObject({ status: "running", runId: "run-new" });
});
