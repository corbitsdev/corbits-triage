import { describe, expect, test } from "bun:test";
import { ApiError, type Transport } from "@intx/hub-client";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { createHoldQueue, HOLD_MS } from "./held-actions.ts";
import { projectQueue, runPackDo, type DoRun, type PrItem, type RunLog } from "./hub-api.ts";
import { doWrite } from "./inbox-pane.ts";
import { pendingDos, type PendingDo } from "./pending-dos.ts";

const NOW = new Date("2026-10-01T02:00:00.000Z");
const pull = { repo: "acme/widgets", number: 8 };
const NONE: ReadonlySet<string> = new Set();

function step(kind: string, target: Record<string, unknown>, index = 0): Record<string, unknown> {
  return { id: "route", branch: "no", index, effectId: `effect-${index}`, kind, automatic: false, reason: "Size failed.", target };
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

function labels(dos: PendingDo[]): string[] {
  return dos.map((pending) => pending.label);
}

describe("pendingDos", () => {
  test("each resolved kind is labelled and sent to the hub by reference only", async () => {
    const dos = pendingDos(verdict([
      step("labels", { labels: ["size/xl", "needs-split"] }, 0),
      step("assign", { users: ["alice"] }, 1),
      step("request-review", { users: ["bob"], teams: ["core"] }, 2),
      step("comment", { body: "Please split this." }, 3),
      step("close", {}, 4),
    ]), [], NONE);
    expect(labels(dos)).toEqual(["Add labels size/xl, needs-split", "Assign alice", "Request review from @acme/core, bob", "Comment", "Close"]);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        return { effectId: (body as { index: number }).index.toString(), status: "done", error: null } as never;
      },
      subscribe: () => () => {},
    };
    for (const pending of dos) await runPackDo(transport, "t", pending.ref);
    expect(calls).toEqual(dos.map((_, index) => ({
      method: "POST",
      path: "/api/integrations/github-dos/t",
      body: { runId: "run-8", ...pull, actionId: "route", branch: "no", index },
    })));
  });

  test("the hub's refusal is said plainly", async () => {
    const [pending] = pendingDos(verdict([step("assign", { users: ["alice"] })]), [], NONE);
    const transport: Transport = {
      fetch: async () => {
        throw new ApiError(409, "verdict_outdated", "This verdict predates Dos by reference. Run triage again.");
      },
      subscribe: () => () => {},
    };
    if (pending === undefined) throw new Error("no Do offered");
    await expect(runPackDo(transport, "t", pending.ref)).rejects.toThrow("This verdict is out of date. Run triage again.");
  });

  test("skipped actions and steps, unresolved targets and agents are not offered", () => {
    const dos = pendingDos(verdict([
      { id: "off", skipped: true, reason: "CI is off in this pack." },
      { ...step("assign", { users: ["ops"] }), target: undefined, skipped: true, reason: "Role ops is not defined." },
      step("request-review", { unresolved: "codeowners" }),
      step("labels", { unresolved: "derive", from: "paths" }),
      step("agent", { prompt: "Review it", tools: [] }),
      step("assign", { users: ["alice"] }),
      { id: "old", branch: "no", kind: "assign", automatic: false, reason: "Before Dos by reference.", target: { users: ["bob"] } },
    ]), [], NONE);
    expect(labels(dos)).toEqual(["Assign alice"]);
  });

  test("a flagged duplicate offers no second close", () => {
    const actions = [step("close", {}), step("comment", { body: "Duplicate of #2." })];
    expect(pendingDos(verdict(actions, { duplicate: true }), [], NONE).map((d) => d.kind)).toEqual(["comment"]);
    expect(pendingDos(verdict(actions), [], NONE).map((d) => d.kind)).toEqual(["close", "comment"]);
  });
});

describe("pendingDos against the hub's records", () => {
  const item = verdict([step("labels", { labels: ["size/xl"] }, 0), step("assign", { users: ["alice"] }, 1), step("comment", { body: "Hi" }, 2)]);

  test("a done or satisfied Do is hidden, a running one stays without a second send, and a failed one comes back with the hub's error", () => {
    const runs: DoRun[] = [
      { effectId: "effect-0", status: "done", error: null },
      { effectId: "effect-1", status: "failed", error: "github POST /repos/acme/widgets/issues/8/assignees -> 422" },
      { effectId: "effect-2", status: "satisfied", error: null },
    ];
    expect(pendingDos(item, runs, NONE).map(({ label, running, error }) => ({ label, running, error }))).toEqual([
      { label: "Assign alice", running: false, error: "github POST /repos/acme/widgets/issues/8/assignees -> 422" },
    ]);
    const running: DoRun[] = [{ effectId: "effect-1", status: "running", error: null }];
    expect(pendingDos(item, running, NONE).map(({ label, running }) => ({ label, running }))).toEqual([
      { label: "Add label size/xl", running: false },
      { label: "Assign alice", running: true },
      { label: "Comment", running: false },
    ]);
  });

  test("a held Do is hidden and offered again on Undo, without reaching the hub", () => {
    const timers = { set: () => 1, clear: () => {} };
    const queue = createHoldQueue(timers, HOLD_MS);
    const [first] = pendingDos(item, [], NONE);
    if (first === undefined || item.number === null) throw new Error("no Do offered");
    let held = new Set([first.key]);
    const sent: unknown[] = [];
    async function runDo(ref: unknown): Promise<DoRun> {
      sent.push(ref);
      return { effectId: first?.key ?? "", status: "done", error: null };
    }
    const write = doWrite({ ...item, number: item.number }, first, () => {
      held = new Set();
    });
    queue.hold({
      pending: write.pending,
      send: () => write.send({ write: async () => ({ commentId: null }), replySent: () => {}, runDo }),
      undo: () => write.restore?.(),
      restore: () => write.restore?.(),
      failText: (error) => error,
    });
    expect(labels(pendingDos(item, [], held))).toEqual(["Assign alice", "Comment"]);
    expect(queue.undo()).toBe(true);
    expect(labels(pendingDos(item, [], held))).toEqual(["Add label size/xl", "Assign alice", "Comment"]);
    expect(sent).toEqual([]);
  });
});
