import { describe, expect, test } from "bun:test";
import { VerdictDetail } from "@corbits/triage-contracts";
import { ApiError, type Transport } from "@intx/hub-client";
import { createHoldQueue, HOLD_MS } from "./held-actions.ts";
import { approveHeldDo, projectQueue, type PrItem } from "./hub-api.ts";
import { doWrite } from "./inbox-pane.ts";
import { pendingDos, type PendingDo } from "./pending-dos.ts";

const NOW = "2026-10-01T02:00:00.000Z";
const pull = { repo: "acme/widgets", number: 8 };
const NONE: ReadonlySet<string> = new Set();

function step(kind: string, target: Record<string, unknown>, index = 0): Record<string, unknown> {
  return { id: "route", branch: "no", index, effectId: `effect-${index}`, kind, automatic: false, held: true, reason: "Size failed.", target };
}

/** A pr-triage verdict as the hub's triage-verdicts route answers it, read back the way the inbox reads it. */
function verdict(actions: unknown[]): PrItem {
  const detail = VerdictDetail.assert({ labels: ["triage:needs-decision"], feedback: "Please split this.", actions });
  const recorded = {
    runId: "run-8", at: NOW, headSha: "abc", settled: true, state: "needs-decision", actor: "maintainer", humanGated: true,
    degraded: null, commented: false, checks: [], detail,
  };
  const [item] = projectQueue([{ ...pull, activityAt: null, verdict: recorded, run: null }], [], undefined);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

function labels(dos: PendingDo[]): string[] {
  return dos.map((pending) => pending.label);
}

describe("pendingDos", () => {
  test("each held kind is labelled and approved through the hub by reference only", async () => {
    const dos = pendingDos(verdict([
      step("labels", { labels: ["size/xl", "needs-split"] }, 0),
      step("assign", { users: ["alice"] }, 1),
      step("request-review", { users: ["bob"], teams: ["core"] }, 2),
      step("comment", { body: "Please split this." }, 3),
      step("close", {}, 4),
    ]), NONE, NONE);
    expect(labels(dos)).toEqual(["Add labels size/xl, needs-split", "Assign alice", "Request review from @acme/core, bob", "Comment", "Close"]);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        return { status: "sent" } as never;
      },
      subscribe: () => () => {},
    };
    for (const pending of dos) await approveHeldDo(transport, "t", pending.ref);
    expect(calls).toEqual(dos.map((_, index) => ({
      method: "POST",
      path: "/api/integrations/github-held-dos/t",
      body: { runId: "run-8", ...pull, effectId: `effect-${index}` },
    })));
  });

  test("the hub's refusal is said plainly", async () => {
    const [pending] = pendingDos(verdict([step("assign", { users: ["alice"] })]), NONE, NONE);
    const transport: Transport = {
      fetch: async () => {
        throw new ApiError(409, "do_not_held", "The verdict does not hold this Do.");
      },
      subscribe: () => () => {},
    };
    if (pending === undefined) throw new Error("no Do offered");
    await expect(approveHeldDo(transport, "t", pending.ref)).rejects.toThrow("This action is not waiting for approval. Run triage again.");
  });

  test("Dos written or not held, skipped actions and steps, unresolved targets, agents and hidden Dos are not offered; a failed automatic Do is", () => {
    const dos = pendingDos(verdict([
      { id: "off", skipped: true, reason: "CI is off in this pack." },
      { id: "route", branch: "no", index: 0, effectId: "effect-0", kind: "assign", held: true, skipped: true, reason: "Role ops is not defined." },
      step("request-review", { unresolved: "codeowners" }),
      step("labels", { unresolved: "derive", from: "paths" }),
      step("agent", { prompt: "Review it", tools: [] }),
      { ...step("labels", { labels: ["ran"] }, 5), held: false, automatic: true, status: "done" },
      { ...step("labels", { labels: ["approved"] }, 8), status: "satisfied" },
      { ...step("labels", { labels: ["auto"] }, 9), held: false, automatic: true },
      { ...step("labels", { labels: ["refused"] }, 10), held: false, automatic: true, status: "failed" },
      step("assign", { users: ["alice"] }, 6),
      step("assign", { users: ["skipped"] }, 7),
    ]), new Set(["effect-7"]), NONE);
    expect(labels(dos)).toEqual(["Add label refused", "Assign alice"]);
  });

  test("a Do sent for approval stays hidden until its run fails it, then is offered again with why", () => {
    const sent = new Set([`effect-0:held`]);
    expect(pendingDos(verdict([step("comment", { body: "Hi" }, 0)]), NONE, sent)).toEqual([]);
    const [failed] = pendingDos(verdict([{ ...step("comment", { body: "Hi" }, 0), status: "failed", error: "github POST -> 500" }]), NONE, sent);
    expect(failed).toMatchObject({ label: "Comment", error: "github POST -> 500" });
  });

  test("a Do approved is hidden and offered again on Undo, without reaching the hub", () => {
    const item = verdict([step("labels", { labels: ["size/xl"] }, 0), step("comment", { body: "Hi" }, 1)]);
    const queue = createHoldQueue({ set: () => 1, clear: () => {} }, HOLD_MS);
    const [first] = pendingDos(item, NONE, NONE);
    if (first === undefined || item.number === null) throw new Error("no Do offered");
    let held = new Set([first.sentKey]);
    const sent: unknown[] = [];
    async function approveDo(ref: unknown) {
      sent.push(ref);
    }
    const write = doWrite({ ...item, number: item.number }, first, () => {
      held = new Set();
    });
    queue.hold({
      pending: write.pending,
      send: () => write.send({ write: async () => ({ commentId: null }), replySent: () => {}, approveDo }),
      undo: () => write.restore?.(),
      restore: () => write.restore?.(),
      failText: (error) => error,
    });
    expect(labels(pendingDos(item, NONE, held))).toEqual(["Comment"]);
    expect(queue.undo()).toBe(true);
    expect(labels(pendingDos(item, NONE, held))).toEqual(["Add label size/xl", "Comment"]);
    expect(sent).toEqual([]);
  });
});
