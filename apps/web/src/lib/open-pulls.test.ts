import { describe, expect, test } from "bun:test";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { projectQueue, type OpenPulls, type RunLog } from "./hub-api.ts";
import { openItems, withPull, type Handled } from "./open-pulls.ts";

const NOW = new Date("2026-10-01T02:00:00.000Z");
const KEY = "acme/widgets#8";
const inline = (value: unknown) => ({ ref: `inline:${JSON.stringify(value)}` });

/** A pr-triage run for #8 started by `trigger` (`event:action`, or none for a catch-up), with a ready verdict and the CI state it saw. */
function run(runId: string, at: string, trigger: string | null, checks = "success"): RunLog {
  const [event, action] = trigger === null ? [] : trigger.split(":");
  const request = { kind: "pr", repo: "acme/widgets", prNumber: 8, event, action };
  return {
    runId,
    anchorRunId: "pr",
    events: [
      { seq: 0, type: "RunStarted", body: { at, trigger: { payload: stockTriggerMail(request) } } },
      { seq: 1, type: "StepCompleted", body: { at, stepId: "rules", output: inline({ repo: "acme/widgets", number: 8, facts: { checks } }) } },
      { seq: 2, type: "StepCompleted", body: { at, stepId: "render", output: inline({ repo: "acme/widgets", number: 8, state: "ready-monitoring" }) } },
      { seq: 3, type: "RunCompleted", body: { at } },
    ],
  };
}

function open(sha: string, numbers = [8]): OpenPulls {
  const prs = numbers.map((number) => ({ number, title: "Fix", author: "ada", draft: false, sha, updatedAt: "2026-10-01T00:00:00.000Z", labels: [] }));
  return { repos: [{ repo: "acme/widgets", prs }] } as OpenPulls;
}

const PUSHED = run("run-1", "2026-10-01T00:00:00.000Z", "pull_request:synchronize", "pending");

function marksOf(logs: RunLog[], pulls: OpenPulls, handled: Handled, held: Handled = {}) {
  return openItems(projectQueue(logs, [], [], pulls, NOW), handled, held).map((entry) => [entry.item.key, entry.handled]);
}

function approved(): Handled {
  const [item] = projectQueue([PUSHED], [], [], open("a"), NOW);
  if (item === undefined) throw new Error("no item");
  expect(item).toMatchObject({ ci: "pending", headSha: "a", activityAt: "2026-10-01T00:00:00.000Z" });
  return withPull({}, item, "approve");
}

describe("handled pull requests", () => {
  test("a CI or catch-up verdict keeps the pull request handled", () => {
    const later = [PUSHED, run("run-2", "2026-10-01T01:00:00.000Z", "check_run:completed"), run("run-3", "2026-10-01T01:30:00.000Z", null)];
    expect(marksOf(later, open("a"), approved())).toEqual([[KEY, { kind: "approve" }]]);
  });

  test("a push, comment or review request brings the pull request back", () => {
    const handled = approved();
    expect(marksOf([PUSHED], open("b"), handled)).toEqual([[KEY, null]]);
    for (const trigger of ["pull_request:synchronize", "issue_comment:created", "pull_request:review_requested"]) {
      expect(marksOf([PUSHED, run("run-2", "2026-10-01T01:00:00.000Z", trigger)], open("a"), handled)).toEqual([[KEY, null]]);
    }
  });

  test("a run log or head not loaded yet keeps the pull request handled", () => {
    const pushedAgain = run("run-2", "2026-10-01T01:00:00.000Z", "pull_request:synchronize");
    const [item] = projectQueue([PUSHED, pushedAgain], [], [], open("a"), NOW);
    if (item === undefined) throw new Error("no item");
    expect(marksOf([PUSHED], open("a"), withPull({}, item, "approve"))).toEqual([[KEY, { kind: "approve" }]]);
    const failed: OpenPulls = { repos: [{ repo: "acme/widgets", prs: [], error: "rate limited" }] };
    expect(marksOf([PUSHED], failed, approved())).toEqual([[KEY, { kind: "approve" }]]);
  });

  test("a merge or close leaves both lists, held or sent", () => {
    const [item] = projectQueue([PUSHED], [], [], open("a"), NOW);
    if (item === undefined) throw new Error("no item");
    expect(marksOf([PUSHED], open("a"), withPull({}, item, "merge"))).toEqual([]);
    expect(marksOf([PUSHED], open("a"), {}, withPull({}, item, "close"))).toEqual([]);
  });

  test("an entry stored before kinds were recorded matches on the verdict run it answered", () => {
    expect(marksOf([PUSHED], open("a"), { [KEY]: "run-1" })).toEqual([[KEY, { kind: null }]]);
    expect(marksOf([PUSHED, run("run-2", "2026-10-01T01:00:00.000Z", "check_run:completed")], open("a"), { [KEY]: "run-1" })).toEqual([[KEY, null]]);
  });
});
