import { describe, expect, test } from "bun:test";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { projectQueue, type PrItem, type RunLog } from "./hub-api.ts";
import { pendingDos, unranDos, withoutRan, withRan } from "./pending-dos.ts";

const NOW = new Date("2026-10-01T02:00:00.000Z");
const pull = { repo: "acme/widgets", number: 8 };

function step(kind: string, target: Record<string, unknown>): Record<string, unknown> {
  return { id: "route", branch: "no", kind, automatic: false, reason: "Size failed.", target };
}

/** A pr-triage verdict as the run log carries it, read back the way the inbox reads it. */
function verdict(actions: unknown[], extra: Record<string, unknown> = {}): PrItem {
  const log: RunLog = {
    runId: "run-8",
    anchorRunId: "run-8",
    events: [
      { seq: 0, type: "RunStarted", body: { trigger: { payload: stockTriggerMail({ kind: "pr", ...pull, prNumber: 8 }) } } },
      {
        seq: 1,
        type: "StepCompleted",
        body: {
          stepId: "renderJudged",
          output: { ref: `inline:${JSON.stringify({ ...pull, state: "needs-decision", labels: ["triage:needs-decision"], feedback: "Please split this.", actions, ...extra })}` },
        },
      },
    ],
  };
  const [item] = projectQueue([log], [], [], undefined, NOW);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

describe("pendingDos", () => {
  test("each resolved kind becomes the hub action body and a label", () => {
    const dos = pendingDos(verdict([
      step("labels", { labels: ["size/xl", "needs-split"] }),
      step("assign", { users: ["alice"] }),
      step("request-review", { users: ["bob"], teams: ["core"] }),
      step("comment", { body: "Please split this." }),
      step("close", {}),
    ]));
    expect(dos.map(({ label, request }) => ({ label, request }))).toEqual([
      { label: "Add labels size/xl, needs-split", request: { action: "labels", ...pull, labels: ["size/xl", "needs-split"] } },
      { label: "Assign alice", request: { action: "assign", ...pull, assignees: ["alice"] } },
      { label: "Request review from @acme/core, bob", request: { action: "request-review", ...pull, reviewers: ["bob"], teamReviewers: ["core"] } },
      { label: "Comment", request: { action: "comment", ...pull, body: "Please split this." } },
      { label: "Close", request: { action: "close", ...pull, labels: ["triage:needs-decision"], comment: "Please split this." } },
    ]);
    expect(dos[0]).toMatchObject({ actionId: "route", kind: "labels", reason: "Size failed." });
  });

  test("request-review leaves out an empty half", () => {
    const [only] = pendingDos(verdict([step("request-review", { users: [], teams: ["core"] })]));
    expect(only?.request).toEqual({ action: "request-review", ...pull, teamReviewers: ["core"] });
  });

  test("skipped actions and steps, unresolved targets and agents are not offered", () => {
    const dos = pendingDos(verdict([
      { id: "off", skipped: true, reason: "CI is off in this pack." },
      { ...step("assign", { users: ["ops"] }), target: undefined, skipped: true, reason: "Role ops is not defined." },
      step("request-review", { unresolved: "codeowners" }),
      step("labels", { unresolved: "derive", from: "paths" }),
      step("agent", { prompt: "Review it", tools: [] }),
      step("assign", { users: ["alice"] }),
    ]));
    expect(dos.map((d) => d.label)).toEqual(["Assign alice"]);
  });

  test("a flagged duplicate offers no second close", () => {
    const actions = [step("close", {}), step("comment", { body: "Duplicate of #2." })];
    expect(pendingDos(verdict(actions, { duplicate: true })).map((d) => d.kind)).toEqual(["comment"]);
    expect(pendingDos(verdict(actions)).map((d) => d.kind)).toEqual(["close", "comment"]);
  });
});

describe("unranDos", () => {
  test("a sent Do stays hidden for its verdict and comes back with a new run", () => {
    const item = verdict([step("labels", { labels: ["size/xl"] }), step("assign", { users: ["alice"] })]);
    const ran = withRan({}, item, pendingDos(item)[0]?.key ?? "");
    expect(unranDos(item, ran).map((d) => d.label)).toEqual(["Assign alice"]);
    expect(unranDos({ ...item, runId: "run-9" }, ran).map((d) => d.label)).toEqual(["Add label size/xl", "Assign alice"]);
  });

  test("a held Do that is undone or fails is offered again", () => {
    const item = verdict([step("labels", { labels: ["size/xl"] })]);
    const key = pendingDos(item)[0]?.key ?? "";
    expect(unranDos(item, withRan({}, item, key))).toEqual([]);
    expect(unranDos(item, withoutRan(withRan({}, item, key), item, key)).map((d) => d.label)).toEqual(["Add label size/xl"]);
  });
});
