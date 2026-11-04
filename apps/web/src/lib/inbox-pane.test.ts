import { describe, expect, test } from "bun:test";
import type { GithubPullDetail, PrGithubWriteInput, PrItem } from "./hub-api.ts";
import { paneActions, paneFacts, paneWrite, type PaneGate, type WriteKind } from "./inbox-pane.ts";

function item(overrides: Partial<PrItem>): PrItem {
  const base: PrItem = {
    key: "acme/widgets#1",
    repo: "acme/widgets",
    number: 1,
    title: "Fix",
    author: "ada",
    authorKind: null,
    byTriage: false,
    draft: false,
    mergeable: null,
    mergeBlock: null,
    state: "needs-decision",
    priority: "P2",
    owner: null,
    nextAction: null,
    verdict: "unsure",
    score: 0.5,
    reasons: [],
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    verdictSha: null,
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
    reviewAnswered: false,
    posted: false,
    running: false,
    waitingForCi: false,
    waitingHeadSha: null,
    awaiting: [],
    failure: null,
    actions: [],
    automatic: [],
    href: "/prs/acme/widgets/1",
    source: "github",
    url: null,
  };
  return Object.assign(base, overrides);
}

function gate(overrides: Partial<PrItem>, detail?: GithubPullDetail, flags: Partial<Pick<PaneGate, "readOnly" | "busy">> = {}): PaneGate {
  const pr = item(overrides);
  return { item: pr, facts: paneFacts(pr, detail), readOnly: false, busy: false, ...flags };
}

function detail(pr: Partial<GithubPullDetail["pr"]>): GithubPullDetail {
  const base: GithubPullDetail["pr"] = {
    number: 1,
    title: "Live title",
    body: null,
    shownBody: "",
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
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    pr: Object.assign(base, pr),
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

  test("nothing runs on a running, unnumbered or read-only pull request", () => {
    expect(paneActions(gate({ running: true })).primary?.blocker).toBe("running");
    expect(paneActions(gate({ number: null })).primary?.blocker).toBe("no-number");
    expect(paneActions(gate({}, undefined, { readOnly: true })).more.map((row) => row.blocker)).toEqual(["read-only", "read-only", "read-only", "read-only"]);
  });
});

describe("paneWrite", () => {
  async function record(kind: WriteKind, overrides: Partial<PrItem>, text: string): Promise<{ calls: unknown[] }> {
    const calls: unknown[] = [];
    async function write(input: PrGithubWriteInput) {
      calls.push(input);
      return { commentId: 7 };
    }
    function replySent(sent: PrItem) {
      calls.push({ sent: sent.key });
    }
    async function approveDo(): Promise<never> {
      throw new Error("a pane write approves no pack Do");
    }
    async function automate(): Promise<never> {
      throw new Error("a pane write leaves no kind to Triage");
    }
    const pr = item(overrides);
    if (pr.number === null) throw new Error("test item needs a number");
    await paneWrite(kind, { ...pr, number: pr.number }, text).send({ write, replySent, approveDo, automate });
    return { calls };
  }

  test("a merge is pinned to the commit Triage checked, and refused before it is held when that is unknown", async () => {
    expect((await record("merge", { verdictSha: "checked", headSha: "newer" }, "")).calls).toEqual([{ action: "merge", repo: "acme/widgets", number: 1, headSha: "checked" }]);
    expect(() => paneWrite("merge", { ...item({}), number: 1 }, "")).toThrow("The commit Triage checked is not known");
  });
});
