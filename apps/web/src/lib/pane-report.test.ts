import { describe, expect, test } from "bun:test";
import type { CheckResult, DoRun, GithubPullDetail, PrItem } from "./hub-api.ts";
import { paneFacts } from "./inbox-pane.ts";
import { approvedByTriage, paneBar, paneProblems, paneStatus, passedChecks, type StatusInput } from "./pane-report.ts";

function item(overrides: Partial<PrItem>): PrItem {
  return {
    key: "acme/widgets#1",
    repo: "acme/widgets",
    number: 1,
    title: "Fix",
    author: "ada",
    authorKind: null,
    draft: false,
    mergeable: true,
    state: "needs-decision",
    priority: "P2",
    owner: null,
    nextAction: null,
    confidence: 0.5,
    merge: null,
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    verdictSha: "head-1",
    degraded: null,
    needsHuman: false,
    closed: false,
    pendingApprovalId: null,
    runId: "run-1",
    waitingSince: "2026-10-01T04:00:00.000Z",
    updatedAt: null,
    ci: null,
    headSha: "head-1",
    activityAt: null,
    reviewAnswered: false,
    posted: false,
    running: false,
    failure: null,
    actions: [],
    href: "/prs/acme/widgets/1",
    ...overrides,
  };
}

function check(overrides: Partial<CheckResult>): CheckResult {
  return { check: "size", kind: "machine", result: "pass", reason: null, evidence: [], output: null, gate: false, ...overrides };
}

const FAIL = check({ check: "docs", kind: "model", result: "fail", reason: "the new retry path is not documented", evidence: ["retry.rs:40-49"], output: { kind: "score", score: 20, passAt: 70, items: [{ path: "retry.rs", added: { start: 40, end: 49 } }] } });
const UNSURE = check({ check: "focused", kind: "model", result: "unconfirmed", reason: "not sure the old job can go", output: { kind: "score", score: 50, passAt: 70, items: [] } });
const CANT = check({ check: "conflicts", result: "unconfirmed", reason: "mergeability not yet computed", output: { kind: "could-not-check", reason: "mergeability not yet computed" } });

function barOf(pr: PrItem, detail?: GithubPullDetail, readOnly = false) {
  return paneBar({ item: pr, facts: paneFacts(pr, detail), readOnly, busy: false }, "main", pr.author);
}

function statusOf(overrides: Partial<PrItem>, input: Partial<Omit<StatusInput, "item" | "primary">> = {}) {
  const pr = item(overrides);
  return paneStatus({ item: pr, detail: undefined, handled: null, approved: false, primary: barOf(pr, input.detail).primary, ...input });
}

function detail(pr: Partial<GithubPullDetail["pr"]>): GithubPullDetail {
  return {
    pr: { number: 1, title: "Fix", body: null, state: "open", merged: false, draft: false, author: "ada", sha: "head-1", base: "main", mergeable: true, requestedReviewers: 0, additions: 1, deletions: 1, changedFiles: 1, labels: [], createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...pr },
    files: [], commits: [], comments: [], issues: [], checks: [], reviews: [],
  };
}

describe("paneProblems", () => {
  test("lists only what is in the way, failures first, with cited lines apart from other evidence", () => {
    const gate = check({ check: "custom-1", result: "fail", gate: true });
    const size = check({ check: "size", result: "fail", reason: "pull request is over the size limits", evidence: ["31 files (max 30)"], output: { kind: "values", values: { files: 31 } } });
    const problems = paneProblems([CANT, check({}), UNSURE, gate, FAIL, size]);
    expect(problems.map((problem) => [problem.check.check, problem.severity])).toEqual([["docs", "fail"], ["size", "fail"], ["focused", "unsure"], ["conflicts", "cant"]]);
    expect(problems[0]).toMatchObject({ text: "The new retry path is not documented", cited: ["retry.rs:40-49"], notes: [] });
    expect(problems[1]).toMatchObject({ cited: [], notes: ["31 files (max 30)"] });
  });

  test("an undecided gate could not be checked; a check from before outputs is unsure only when a model asked it", () => {
    expect(paneProblems([check({ result: "unconfirmed", gate: true })])[0]?.severity).toBe("cant");
    expect(paneProblems([check({ kind: "model", result: "unconfirmed" })])[0]).toMatchObject({ severity: "unsure", text: null });
    expect(paneProblems([check({ result: "unconfirmed" })])[0]?.severity).toBe("cant");
  });
});

describe("paneStatus", () => {
  test("each state reads as one line with its tone", () => {
    expect(statusOf({ checks: [FAIL, UNSURE, CANT], comment: "Please add a test." })).toMatchObject({ tone: "you", text: "Needs your reply · 1 thing to fix, 2 to check" });
    expect(statusOf({ checks: [UNSURE, CANT, check({})] })).toMatchObject({ tone: "you", text: "Not sure about 2 things — your call" });
    expect(statusOf({ checks: [CANT, check({})] })).toMatchObject({ tone: "you", text: "Couldn't check 1 thing" });
    expect(statusOf({ state: "ready", checks: [check({})] })).toMatchObject({ tone: "ready", text: "Ready to merge" });
    expect(statusOf({ state: "ready" }, { approved: true })).toMatchObject({ tone: "ready", text: "Approved by Triage · ready for you to merge" });
    expect(statusOf({ running: true })).toMatchObject({ text: "Triage running…", live: true });
    expect(statusOf({ state: "new", runId: null, failure: "stuck" }).text).toBe("Couldn't triage: the run stopped responding");
    expect(statusOf({ state: "new", runId: null }).text).toBe("Not triaged yet");
  });

  test("agrees with the list and the primary: re-review, rechecking, and never asking for a reply when the button approves", () => {
    const requested = check({ check: "review", result: "fail", reason: "a reviewer requested changes" });
    expect(statusOf({ state: "needs-author-update", checks: [requested], reviewAnswered: true })).toMatchObject({ text: "Ready for your re-review" });
    expect(barOf(item({ state: "needs-author-update", checks: [requested], reviewAnswered: true })).primary?.kind).toBe("approve");
    expect(statusOf({ state: "stale" }).text).toBe("Rechecking");
    const draft = check({ check: "draft", result: "fail", reason: "pull request is a draft" });
    expect(barOf(item({ state: "awaiting-review", checks: [draft] })).primary?.kind).toBe("approve");
    expect(statusOf({ state: "awaiting-review", checks: [draft] }).text).toBe("Waiting for review · 1 thing to fix");
  });

  test("commits Triage has not checked are rechecked, never ready, and never merged from the primary", () => {
    const stale = { state: "ready" as const, verdictSha: "head-1", headSha: "head-2" };
    expect(statusOf(stale, { approved: true })).toMatchObject({ tone: "quiet", text: "New commits since Triage checked · rechecking" });
    const bar = barOf(item(stale));
    expect(bar.primary).toBeNull();
    expect(bar.more.find((entry) => entry.kind === "merge")).toMatchObject({ blocker: "unchecked-commits", label: "Merge" });
  });

  test("a ready pull request says what holds the merge, and Triage's approval only shows with nothing left to call", () => {
    expect(statusOf({ state: "ready" }, { detail: detail({ draft: true }) }).text).toBe("Ready, but it's a draft");
    expect(statusOf({ state: "ready" }, { detail: detail({ mergeable: false }) }).text).toBe("Ready, but has conflicts");
    expect(statusOf({ state: "ready", checks: [UNSURE] }, { approved: true }).text).toBe("Not sure about 1 thing — your call");
  });

  test("merged or closed, on GitHub or from the inbox, outranks everything", () => {
    expect(statusOf({ checks: [FAIL] }, { detail: detail({ merged: true, state: "closed" }) }).text).toBe("Merged");
    expect(statusOf({}, { detail: detail({ state: "closed" }) }).text).toBe("Closed");
    expect(statusOf({}, { handled: { kind: "merge" } }).text).toBe("Merged");
    expect(statusOf({ closed: true }).text).toBe("Closed");
  });

  test("waiting on the author counts what they must fix; the maintainer's approval names failing checks", () => {
    expect(statusOf({ state: "needs-author-update", posted: true, checks: [FAIL, check({ check: "ci", result: "fail" })] })).toEqual({ tone: "author", text: "Waiting on @ada to fix 2 things", live: false });
    expect(statusOf({ checks: [FAIL] }, { handled: { kind: "changes" } })).toMatchObject({ tone: "author", text: "Waiting on @ada to fix 1 thing" });
    expect(statusOf({ checks: [FAIL] }, { handled: { kind: "approve" } })).toMatchObject({ tone: "you", text: "You approved · 1 check failing" });
  });
});

describe("approvedByTriage", () => {
  const run = (overrides: Partial<DoRun>): DoRun => ({ effectId: "e", actionId: "a", kind: "approve", headSha: "head-1", status: "done", error: null, updatedAt: "", ...overrides });

  test("only the approve Do's settled approval of the current head counts", () => {
    expect(approvedByTriage(item({}), [run({})])).toBe(true);
    expect(approvedByTriage(item({}), [run({ status: "satisfied" })])).toBe(true);
    expect(approvedByTriage(item({ headSha: "head-2" }), [run({})])).toBe(false);
    expect(approvedByTriage(item({}), [run({ status: "failed" })])).toBe(false);
    expect(approvedByTriage(item({}), [run({ kind: "labels" })])).toBe(false);
  });
});

describe("paneBar", () => {
  test("the primary is worded for the state", () => {
    expect(barOf(item({ state: "ready" })).primary).toMatchObject({ kind: "merge", label: "Merge", detail: "into main" });
    expect(barOf(item({ comment: "Please add a test." })).primary).toMatchObject({ kind: "reply", label: "Send feedback", detail: "to @ada" });
    expect(barOf(item({ state: "awaiting-review" })).primary).toMatchObject({ kind: "approve", label: "Approve", detail: null });
    expect(barOf(item({ state: "needs-author-update", posted: true, comment: "Fix it." })).primary).toMatchObject({ kind: "comment", label: "Reply", detail: "to @ada" });
  });

  test("at most two runnable secondaries; the rest, and anything blocked, wait in More", () => {
    const ready = barOf(item({ state: "ready", comment: "Thanks" }));
    expect(ready.secondary.map((entry) => entry.label)).toEqual(["Request changes", "Close"]);
    expect(ready.more.map((entry) => entry.kind)).toEqual(["reply", "approve", "comment", "triage"]);
    expect(barOf(item({ state: "ready" }), undefined, true).secondary).toEqual([]);
  });
});

describe("passedChecks", () => {
  test("a gate that did not match is not a passed check", () => {
    expect(passedChecks([check({ check: "a" }), check({ check: "b", gate: true }), check({ check: "c", gate: true, result: "fail" })]).map((row) => row.check)).toEqual(["a", "b"]);
  });
});
