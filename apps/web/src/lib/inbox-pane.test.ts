import { describe, expect, test } from "bun:test";
import type { GithubPullDetail, PrGithubWriteInput, PrItem } from "./hub-api.ts";
import { canRun, paneActions, paneFacts, replyDraft, runPaneAction, type PaneGate } from "./inbox-pane.ts";

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
    canClose: false,
    pendingClose: false,
    running: false,
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
    expect(paneActions(gate({}, undefined, { readOnly: true })).more.map((row) => row.blocker)).toEqual(["read-only", "read-only", "read-only"]);
  });

  test("the menu leaves out the suggested action; a duplicate keeps its close row, anything writable closes plainly after a confirm", () => {
    expect(paneActions(gate({ comment: "Thanks" })).more.map((row) => row.label)).toEqual(["Approve", "Request changes", "Comment", "Merge", "Close pull request"]);
    expect(paneActions(gate({ comment: "Thanks" })).more.at(-1)?.confirm).toBe("Close this pull request?");
    expect(paneActions(gate({ comment: "Thanks" }, undefined, { readOnly: true })).more.map((row) => row.kind)).toEqual(["approve", "changes", "comment", "merge"]);
    expect(paneActions(gate({ canClose: true })).primary?.kind).toBe("close");
    expect(paneActions(gate({ canClose: true })).more.at(-1)).toEqual({ kind: "close", blocker: null, label: "Close as duplicate", confirm: null });
    expect(paneActions(gate({ canClose: true }, undefined, { readOnly: true })).more.at(-1)).toEqual({ kind: "close", blocker: "read-only", label: "Close as duplicate", confirm: null });
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
});

describe("runPaneAction", () => {
  async function record(kind: "reply" | "close", overrides: Partial<PrItem>, text: string): Promise<PrGithubWriteInput[]> {
    const writes: PrGithubWriteInput[] = [];
    async function write(input: PrGithubWriteInput) {
      writes.push(input);
    }
    const pr = item(overrides);
    if (pr.number === null) throw new Error("test item needs a number");
    await runPaneAction(kind, { ...pr, number: pr.number }, replyDraft(pr, text), write);
    return writes;
  }

  test("posting the reply applies the verdict's labels after it", async () => {
    expect(await record("reply", { comment: "Thanks", labels: ["wanted"] }, "Thanks, edited")).toEqual([
      { action: "reply", repo: "acme/widgets", number: 1, body: "Thanks, edited" },
      { action: "labels", repo: "acme/widgets", number: 1, labels: ["wanted"] },
    ]);
  });

  test("closing a duplicate without a drafted comment posts none", async () => {
    expect(await record("close", { canClose: true, labels: ["duplicate"] }, "")).toEqual([
      { action: "close", repo: "acme/widgets", number: 1, labels: ["duplicate"], comment: "" },
    ]);
  });
});
