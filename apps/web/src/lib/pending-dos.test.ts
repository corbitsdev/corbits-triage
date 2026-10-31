import { describe, expect, test } from "bun:test";
import { VerdictDetail } from "@corbits/triage-contracts";
import { ApiError, type Transport } from "@intx/hub-client";
import { createHoldQueue, HOLD_MS } from "./held-actions.ts";
import { approveHeldDo, projectQueue, type HubApproval, type PrItem } from "./hub-api.ts";
import { doWrite } from "./inbox-pane.ts";
import { actionMode } from "./inbox-view.ts";
import { heldOffer, pendingDos, withoutDecidedDos, type PendingDo } from "./pending-dos.ts";

const NOW = "2026-10-01T02:00:00.000Z";
const pull = { repo: "acme/widgets", number: 8 };
const NONE: ReadonlySet<string> = new Set();

function step(kind: string, target: Record<string, unknown>, index = 0): Record<string, unknown> {
  return { list: "fail", index, effectId: `effect-${index}`, kind, held: true, reason: "Size failed.", target };
}

function verdict(actions: unknown[], automatic: string[] = []): PrItem {
  const detail = VerdictDetail.assert({ labels: ["triage:needs-decision"], feedback: "Please split this.", actions, ...(automatic.length > 0 ? { automatic } : {}) });
  const recorded = {
    runId: "run-8", at: NOW, headSha: "abc", verdict: "fail" as const, settled: true, state: "needs-decision", actor: "maintainer", humanGated: true,
    degraded: null, commented: false, checks: [], detail,
  };
  const [item] = projectQueue([{ ...pull, source: "github", activityAt: null, verdict: recorded, run: null }], [], undefined);
  if (item === undefined) throw new Error("no verdict projected");
  return item;
}

function labels(dos: PendingDo[]): string[] {
  return dos.map((pending) => pending.label);
}

describe("pendingDos", () => {
  test("a held merge off a Fail list says the verdict was not pass", () => {
    expect(labels(pendingDos(verdict([step("merge", {}, 0)])))).toEqual(["Merge (the verdict was fail, not pass)"]);
  });

  test("a pull request Triage opened offers no held review, only its other held actions", () => {
    const own = { ...verdict([step("approve", {}, 0), step("comment", { body: "Thanks." }, 1)]), byTriage: true };
    expect(pendingDos(own).map((pending) => pending.kind)).toEqual(["comment"]);
  });

  test("each held kind is labelled and approved through the hub by reference only", async () => {
    const dos = pendingDos(verdict([
      step("labels", { labels: ["size/xl", "needs-split"] }, 0),
      step("assign", { users: ["alice"] }, 1),
      step("request-review", { users: ["bob"], teams: ["core"] }, 2),
      step("comment", { body: "Please split this." }, 3),
      step("close", {}, 4),
    ]));
    expect(labels(dos)).toEqual(["Add labels size/xl, needs-split", "Assign alice", "Request review from @acme/core, bob", "Comment \"Please split this.\"", "Close"]);
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: Transport = {
      fetch: async (method, path, body) => {
        calls.push({ method, path, body });
        return { status: "sent" } as never;
      },
      subscribe: () => () => {},
    };
    for (const pending of dos) await approveHeldDo(transport, "t", pending.ref);
    expect(calls).toEqual(dos.map((pending, index) => ({
      method: "POST",
      path: "/api/integrations/github-held-dos/t",
      body: { runId: "run-8", ...pull, source: "github", effectId: `effect-${index}`, kind: pending.kind },
    })));
  });

  test("the hub's refusal is said plainly", async () => {
    const [pending] = pendingDos(verdict([step("assign", { users: ["alice"] })]));
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
    const dos = pendingDos(withoutDecidedDos(verdict([
            { list: "fail", index: 0, effectId: "effect-0", kind: "assign", held: true, skipped: true, reason: "Role ops is not defined." },
      step("request-review", { unresolved: "codeowners" }),
      step("labels", { unresolved: "derive", from: "paths" }),
      step("agent", { prompt: "Review it", tools: [] }),
      { ...step("labels", { labels: ["ran"] }, 5), held: false, status: "done" },
      { ...step("labels", { labels: ["approved"] }, 8), status: "satisfied" },
      { ...step("labels", { labels: ["auto"] }, 9), held: false },
      { ...step("labels", { labels: ["refused"] }, 10), held: false, status: "failed" },
      step("assign", { users: ["alice"] }, 6),
      step("assign", { users: ["skipped"] }, 7),
    ]), new Set(["effect-7"]), NONE));
    expect(labels(dos)).toEqual(["Add label refused", "Assign alice"]);
  });

  test("a Do sent for approval stays hidden until its run fails it, then is offered again with why", () => {
    const sent = new Set([`effect-0:held`]);
    expect(pendingDos(withoutDecidedDos(verdict([step("comment", { body: "Hi" }, 0)]), NONE, sent))).toEqual([]);
    const [failed] = pendingDos(withoutDecidedDos(verdict([{ ...step("comment", { body: "Hi" }, 0), status: "failed", error: "github POST -> 500" }]), NONE, sent));
    expect(failed).toMatchObject({ label: "Comment \"Hi\"", error: "github POST -> 500" });
  });

  test("a Do approved is hidden and offered again on Undo, without reaching the hub", () => {
    const item = verdict([step("labels", { labels: ["size/xl"] }, 0), step("comment", { body: "Hi" }, 1)]);
    const queue = createHoldQueue({ set: () => 1, clear: () => {} }, HOLD_MS);
    const [first] = pendingDos(item);
    if (first === undefined || item.number === null) throw new Error("no Do offered");
    let held = new Set([first.sentKey]);
    const sent: unknown[] = [];
    async function approveDo(ref: unknown) {
      sent.push(ref);
    }
    const write = doWrite({ ...item, number: item.number }, first, () => {
      held = new Set();
    }, false);
    queue.hold({
      pending: write.pending,
      send: () => write.send({ write: async () => ({ commentId: null }), replySent: () => {}, approveDo, automate: async () => {} }),
      undo: () => write.restore?.(),
      restore: () => write.restore?.(),
      failText: (error) => error,
    });
    expect(labels(pendingDos(withoutDecidedDos(item, NONE, held)))).toEqual(["Comment \"Hi\""]);
    expect(queue.undo()).toBe(true);
    expect(labels(pendingDos(withoutDecidedDos(item, NONE, held)))).toEqual(["Add label size/xl", "Comment \"Hi\""]);
    expect(sent).toEqual([]);
  });
});

describe("heldOffer", () => {
  test("Running it once needs the Do's grant; Always also needs grant create and a kind the policy names, never shows for a kind the verdict always holds, and neither shows while it waits for CI", () => {
    const wanted = ["request-review", "merge", "close"] as const;
    const both = { holdsDo: true, createsGrants: true, wanted, onPrimary: false };
    expect(heldOffer({ list: "fail", kind: "request-review", until: null }, both)).toEqual({ doIt: true, always: true });
    expect(heldOffer({ list: "fail", kind: "request-review", until: null }, { ...both, createsGrants: false })).toEqual({ doIt: true, always: false });
    expect(heldOffer({ list: "fail", kind: "request-review", until: null }, { ...both, holdsDo: false })).toEqual({ doIt: false, always: false });
    expect(heldOffer({ list: "fail", kind: "assign", until: null }, both)).toEqual({ doIt: true, always: false });
    expect(heldOffer({ list: "pass", kind: "merge", until: null }, both)).toEqual({ doIt: true, always: true });
    expect(heldOffer({ list: "fail", kind: "merge", until: null }, both)).toEqual({ doIt: true, always: false });
    expect(heldOffer({ list: "unsure", kind: "close", until: null }, both)).toEqual({ doIt: true, always: false });
    expect(heldOffer({ list: "fail", kind: "close", until: null }, both)).toEqual({ doIt: true, always: true });
    expect(heldOffer({ list: "pass", kind: "merge", until: "CI finishes" }, both)).toEqual({ doIt: false, always: false });
  });

  test("one the pane's primary button already carries out has no button of its own, but may still be left to Triage", () => {
    const access = { holdsDo: true, createsGrants: true, wanted: ["merge"] as const, onPrimary: true };
    expect(heldOffer({ list: "pass", kind: "merge", until: null }, access)).toEqual({ doIt: false, always: true });
  });
});

describe("actionMode", () => {
  test("a held action stays waiting even when that kind is on the automatic list", () => {
    const item = verdict([step("merge", {}, 0)], ["merge"]);
    expect(actionMode(item)).toEqual({ mode: "waiting", reason: "Size failed." });
  });

  test("a pull request that needs a person with an approval pending is waiting", () => {
    const item = { ...verdict([]), pendingApprovalId: "a1", reasons: ["Needs a person."] };
    expect(actionMode(item)).toEqual({ mode: "waiting", reason: "Needs a person." });
  });

  test("a done automatic action stays waiting while an approval is still pending, even after it no longer needs a person", () => {
    const item = {
      ...verdict([{ ...step("comment", { body: "Hi" }, 0), held: false, status: "done" }], ["comment"]),
      needsHuman: false,
      pendingApprovalId: "a1",
    };
    expect(actionMode(item)?.mode).toBe("waiting");
  });
});

const REPO = "acme/api";

function heldPull(source: "github" | "bitbucket-datacenter", at: string) {
  const detail = VerdictDetail.assert({ labels: ["triage:needs-decision"], feedback: "Please split this.", actions: [step("comment", { body: "Hi" })] });
  return {
    repo: REPO, number: 1, source, activityAt: null, run: null,
    verdict: {
      runId: `run-${source}`, at, headSha: "abc", verdict: "fail" as const, settled: true, state: "needs-decision", actor: "maintainer", humanGated: true,
      degraded: null, commented: false, checks: [], detail,
    },
  };
}

function listed(source: "github" | "bitbucket-datacenter", numbers: number[]) {
  const prs = numbers.map((number) => ({ number, title: "Fix", author: "ada", draft: false, sha: "abc", updatedAt: NOW, labels: [] as string[] }));
  return { repo: REPO, source, prs };
}

describe("a held Do's host", () => {
  test("a Bitbucket verdict keeps its host when no open pull requests are loaded", () => {
    const [item] = projectQueue([heldPull("bitbucket-datacenter", NOW)], [], undefined);
    if (item === undefined) throw new Error("no verdict projected");
    expect(pendingDos(item)[0]?.source).toBe("bitbucket-datacenter");
  });

  test("the newer GitHub verdict keeps its host when both hosts list the same number", () => {
    const open = { repos: [listed("github", [1]), listed("bitbucket-datacenter", [1])] };
    const [item] = projectQueue([heldPull("bitbucket-datacenter", "2026-10-01T00:00:00.000Z"), heldPull("github", "2026-10-02T00:00:00.000Z")], [], open);
    if (item === undefined) throw new Error("no verdict projected");
    expect(pendingDos(item)[0]?.source).toBe("github");
  });

  test("a Bitbucket listing that omits the number does not close a GitHub verdict or change its host", () => {
    const [item] = projectQueue([heldPull("github", NOW)], [], { repos: [listed("bitbucket-datacenter", [])] });
    expect(item).toMatchObject({ source: "github", closed: false });
  });

  test("a GitHub mirror approval does not attach to a Bitbucket verdict", () => {
    const approval: HubApproval = {
      id: "mirror", tenantId: "tenant", runId: "run-bitbucket-datacenter", anchorRunId: "run-bitbucket-datacenter", agentAddress: "run-bitbucket-datacenter",
      status: "pending", scope: null, toolDefinition: { name: "github_mirror" }, toolArguments: { repo: REPO, number: 1 },
      correlationId: "mirror", timeoutAt: null, resolvedAt: null, createdAt: NOW, updatedAt: NOW,
    };
    const [item] = projectQueue([heldPull("bitbucket-datacenter", NOW)], [approval], undefined);
    expect(item).toMatchObject({ source: "bitbucket-datacenter", pendingApprovalId: null });
  });
});
