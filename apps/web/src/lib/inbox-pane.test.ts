import { describe, expect, test } from "bun:test";
import type { Outcome } from "./held-actions.ts";
import type { GithubPullDetail, PrGithubWriteInput, PrItem } from "./hub-api.ts";
import { canRun, needsConfirm, paneActions, paneFacts, paneWrite, replyDraft, type PaneGate } from "./inbox-pane.ts";

function item(overrides: Partial<PrItem>): PrItem {
  return {
    key: "acme/widgets#1",
    repo: "acme/widgets",
    number: 1,
    title: "Fix",
    author: "ada",
    draft: false,
    mergeable: null,
    state: "needs-decision",
    priority: "P2",
    owner: null,
    nextAction: null,
    confidence: 0.5,
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    degraded: null,
    needsHuman: false,
    closed: false,
    pendingApprovalId: null,
    runId: "run-1",
    waitingSince: "2026-10-01T00:00:00.000Z",
    updatedAt: null,
    ci: null,
    headSha: null,
    activityAt: null,
    canClose: false,
    pendingClose: false,
    posted: false,
    running: false,
    failure: null,
    actions: [],
    href: "/prs/acme/widgets/1",
    ...overrides,
  };
}

function gate(overrides: Partial<PrItem>, detail?: GithubPullDetail, flags: Partial<Pick<PaneGate, "readOnly" | "busy">> = {}): PaneGate {
  const pr = item(overrides);
  return { item: pr, facts: paneFacts(pr, detail), readOnly: false, busy: false, ...flags };
}

function detail(pr: Partial<GithubPullDetail["pr"]>): GithubPullDetail {
  return {
    pr: {
      number: 1,
      title: "Live title",
      body: null,
      state: "open",
      merged: false,
      draft: false,
      author: "grace",
      sha: "abc",
      base: "main",
      mergeable: true,
      requestedReviewers: 0,
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      labels: [],
      updatedAt: "2026-10-01T00:00:00.000Z",
      ...pr,
    },
    files: [],
    commits: [],
    comments: [],
    issues: [],
    checks: [],
    reviews: [],
  };
}

describe("paneActions", () => {
  test("merge needs GitHub to say mergeable and not draft; the verdict's facts stand in until it loads", () => {
    expect(paneActions(gate({ state: "ready", mergeable: true })).primary).toEqual({ kind: "merge", blocker: null });
    expect(paneActions(gate({ state: "ready", mergeable: true }, detail({ mergeable: false }))).primary?.blocker).toBe("not-mergeable");
    expect(paneActions(gate({ state: "ready", mergeable: true }, detail({ draft: true }))).primary?.blocker).toBe("draft");
    expect(paneActions(gate({ state: "ready", mergeable: null })).primary?.blocker).toBe("mergeability-unknown");
  });

  test("merge waits while GitHub is still computing mergeability, even when the verdict said mergeable", () => {
    expect(paneActions(gate({ state: "ready", mergeable: true }, detail({ mergeable: null }))).primary?.blocker).toBe("mergeability-unknown");
  });

  test("nothing runs on a running, unnumbered or read-only pull request", () => {
    expect(paneActions(gate({ running: true })).primary?.blocker).toBe("running");
    expect(paneActions(gate({ number: null })).primary?.blocker).toBe("no-number");
    expect(paneActions(gate({}, undefined, { readOnly: true })).more.map((row) => row.blocker)).toEqual(["read-only", "read-only", "read-only", "read-only"]);
  });

  test("the menu leaves out the suggested action; a duplicate keeps its close row and is confirmed, anything writable closes plainly", () => {
    expect(paneActions(gate({ comment: "Thanks" })).more.map((row) => row.label)).toEqual(["Approve", "Request changes", "Comment", "Merge", "Close pull request", "Triage again"]);
    expect(needsConfirm("close", item({}))).toBe(false);
    expect(needsConfirm("close", item({ canClose: true }))).toBe(true);
    expect(paneActions(gate({ comment: "Thanks" }, undefined, { readOnly: true })).more.map((row) => row.kind)).toEqual(["approve", "changes", "comment", "merge", "triage"]);
    expect(paneActions(gate({ canClose: true })).primary?.kind).toBe("close");
    expect(paneActions(gate({ canClose: true })).more.at(-2)).toEqual({ kind: "close", blocker: null, label: "Close as duplicate" });
    expect(paneActions(gate({ canClose: true }, undefined, { readOnly: true })).more.at(-2)).toEqual({ kind: "close", blocker: "read-only", label: "Close as duplicate" });
  });

  test("a pack close Do stands in for the menu's plain close", () => {
    const actions = [{ id: "stale", kind: "close" as const, reason: "Stale.", target: {} }];
    expect(paneActions(gate({ actions })).more.map((row) => row.kind)).not.toContain("close");
  });

  test("triage again is offered once the hub has run or given up on the pull request, under the same gate as writes", () => {
    const triage = (overrides: Partial<PrItem>, flags: Partial<Pick<PaneGate, "readOnly" | "busy">> = {}) => paneActions(gate(overrides, undefined, flags)).more.find((row) => row.kind === "triage");
    expect(triage({})).toEqual({ kind: "triage", blocker: null, label: "Triage again" });
    expect(triage({ runId: null, state: "new" })).toBeUndefined();
    expect(triage({}, { readOnly: true })?.blocker).toBe("read-only");
    expect(triage({ running: true })?.blocker).toBe("running");
    const failed = paneActions(gate({ runId: null, state: "new", failure: "failed" }));
    expect(failed.primary).toEqual({ kind: "triage", blocker: null });
    expect(failed.more.find((row) => row.kind === "triage")).toBeUndefined();
  });

  test("a drafted reply is the primary action for the author until the mirror posted it, and in the More menu otherwise", () => {
    expect(paneActions(gate({ state: "needs-author-update", comment: "Please rebase" })).primary).toEqual({ kind: "reply", blocker: null });
    expect(paneActions(gate({ state: "needs-author-update", comment: "Please rebase" }, undefined, { readOnly: true })).primary).toEqual({ kind: "reply", blocker: "read-only" });
    expect(paneActions(gate({ state: "needs-author-update", comment: "Please rebase" })).more.find((row) => row.kind === "reply")).toBeUndefined();
    expect(paneActions(gate({ state: "needs-author-update", comment: "Please rebase", posted: true })).primary).toBeNull();
    expect(paneActions(gate({ state: "awaiting-review", comment: "Thanks" })).more.find((row) => row.kind === "reply")).toEqual({ kind: "reply", blocker: null, label: "Post reply" });
    expect(paneActions(gate({ state: "awaiting-review", comment: "Thanks" }, undefined, { readOnly: true })).more.find((row) => row.kind === "reply")?.blocker).toBe("read-only");
  });

  test("an empty or absent draft shows no reply to post anywhere", () => {
    expect(paneActions(gate({ state: "needs-author-update" })).primary).toEqual({ kind: "comment", blocker: null });
    expect(paneActions(gate({})).more.find((row) => row.kind === "reply")).toBeUndefined();
    expect(replyDraft(item({ comment: "" }), "")).toBeNull();
    expect(replyDraft(item({ comment: null }), "")).toBeNull();
    // a degraded verdict's empty comment must not surface an enabled reply row either
    expect(paneActions(gate({ state: "needs-author-update", comment: "" })).primary).toEqual({ kind: "comment", blocker: null });
    expect(paneActions(gate({ state: "awaiting-review", comment: "" })).more.find((row) => row.kind === "reply")).toBeUndefined();
  });
});

describe("canRun", () => {
  test("keyboard shortcuts stop where the buttons are disabled", () => {
    expect(canRun("approve", gate({}))).toBe(true);
    expect(canRun("approve", gate({}, undefined, { readOnly: true }))).toBe(false);
    expect(canRun("approve", gate({}, undefined, { busy: true }))).toBe(false);
    expect(canRun("approve", gate({ running: true }))).toBe(false);
    expect(canRun("merge", gate({ state: "ready", mergeable: null }))).toBe(false);
  });

  test("posting the reply is gated by the same blockers as the primary button", () => {
    expect(canRun("reply", gate({ comment: "Thanks" }))).toBe(true);
    expect(canRun("reply", gate({ comment: "Thanks", number: null }))).toBe(false);
    expect(canRun("reply", gate({ comment: "Thanks", running: true }))).toBe(false);
    expect(canRun("reply", gate({ comment: "Thanks" }, undefined, { readOnly: true }))).toBe(false);
    expect(canRun("reply", gate({ comment: "Thanks" }, undefined, { busy: true }))).toBe(false);
  });
});

describe("paneWrite", () => {
  type Options = { commentId?: number | null; labelsFail?: string; replyFail?: string };
  async function record(kind: "reply" | "close", overrides: Partial<PrItem>, text: string, options: Options = {}): Promise<{ calls: unknown[]; outcome: Outcome }> {
    const calls: unknown[] = [];
    async function write(input: PrGithubWriteInput) {
      calls.push(input);
      if (input.action === "labels" && options.labelsFail !== undefined) throw new Error(options.labelsFail);
      if (input.action === "reply" && options.replyFail !== undefined) throw new Error(options.replyFail);
      return { commentId: options.commentId === undefined ? 7 : options.commentId };
    }
    function replySent(sent: PrItem) {
      calls.push({ sent: sent.key });
    }
    async function runDo(): Promise<never> {
      throw new Error("a pane write sends no pack Do");
    }
    const pr = item(overrides);
    if (pr.number === null) throw new Error("test item needs a number");
    const outcome = await paneWrite(kind, { ...pr, number: pr.number }, text).send({ write, replySent, runDo });
    return { calls, outcome };
  }

  test("the reply and its labels start together, and the verdict is marked sent once the hub names the comment", async () => {
    expect(await record("reply", { comment: "Thanks", labels: ["wanted"] }, "Thanks, edited")).toEqual({
      calls: [
        { action: "reply", repo: "acme/widgets", number: 1, body: "Thanks, edited" },
        { action: "labels", repo: "acme/widgets", number: 1, labels: ["wanted"] },
        { sent: "acme/widgets#1" },
      ],
      outcome: { message: "Posted to GitHub on #1.", complete: true, kept: true },
    });
    await expect(record("reply", { comment: "Thanks" }, "Thanks", { commentId: null })).rejects.toThrow("did not confirm");
    await expect(record("reply", { comment: "Thanks" }, "  ")).rejects.toThrow("must not be empty");
  });

  test("a posted reply whose labels failed is reported as posted, not as unsent", async () => {
    const { calls, outcome } = await record("reply", { comment: "Thanks", labels: ["wanted"] }, "Thanks", { labelsFail: "Label does not exist" });
    expect(calls).toContainEqual({ sent: "acme/widgets#1" });
    expect(outcome).toEqual({ message: "Reply posted to #1; labels were not added. Label does not exist", complete: false, kept: true });
  });

  test("labels that landed without their reply are reported, and the pull request comes back for the reply", async () => {
    const { calls, outcome } = await record("reply", { comment: "Thanks", labels: ["wanted"] }, "Thanks", { replyFail: "Secondary rate limit" });
    expect(calls).not.toContainEqual({ sent: "acme/widgets#1" });
    expect(outcome).toEqual({ message: "Labels added to #1; the reply was not posted. Secondary rate limit", complete: false, kept: false });
    await expect(record("reply", { comment: "Thanks" }, "Thanks", { replyFail: "Secondary rate limit" })).rejects.toThrow("Secondary rate limit");
  });

  test("closing a duplicate without a drafted comment posts none", async () => {
    expect((await record("close", { canClose: true, labels: ["duplicate"] }, "")).calls).toEqual([
      { action: "close", repo: "acme/widgets", number: 1, labels: ["duplicate"], comment: "" },
    ]);
  });
});
