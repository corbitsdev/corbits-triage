import { describe, expect, test } from "bun:test";
import type { CheckResult, GithubPullDetail, PrItem, SuggestedAction } from "./hub-api.ts";
import { mergeBlockOf, paneFacts } from "./inbox-pane.ts";
import { approvedByTriage, paneBar, paneProblems, paneStatus, passedChecks, rowStatus, type StatusInput } from "./pane-report.ts";

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
    waitingForCi: false,
    waitingHeadSha: null,
    failure: null,
    actions: [],
    href: "/prs/acme/widgets/1",
    ...overrides,
  };
}

function check(overrides: Partial<CheckResult>): CheckResult {
  return { check: "max-files-changed", kind: "machine", result: "pass", reason: null, evidence: [], output: null, gate: false, ...overrides };
}

const FAIL = check({ check: "docs", kind: "model", result: "fail", reason: "the new retry path is not documented", evidence: ["retry.rs:40-49"], output: { kind: "score", score: 20, passAt: 70, items: [{ path: "retry.rs", added: { start: 40, end: 49 } }] } });
const UNSURE = check({ check: "focused", kind: "model", result: "unconfirmed", reason: "not sure the old job can go", output: { kind: "score", score: 50, passAt: 70, items: [] } });
const CANT = check({ check: "no-merge-conflicts", result: "unconfirmed", reason: "mergeability not yet computed", output: { kind: "could-not-check", reason: "mergeability not yet computed" } });

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
    const size = check({ check: "max-files-changed", result: "fail", reason: "pull request is over the files limit", evidence: ["31 files (max 30)"], output: { kind: "values", values: { files: 31 } } });
    const problems = paneProblems([CANT, check({}), UNSURE, gate, FAIL, size]);
    expect(problems.map((problem) => [problem.check.check, problem.severity])).toEqual([["docs", "fail"], ["max-files-changed", "fail"], ["focused", "unsure"], ["no-merge-conflicts", "cant"]]);
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
    expect(statusOf({ checks: [CANT, check({})] })).toMatchObject({ tone: "you", text: "Couldn't check 1 thing: Mergeability not yet computed" });
    expect(statusOf({ state: "ready", checks: [check({})] })).toMatchObject({ tone: "ready", text: "Ready to merge" });
    expect(statusOf({ state: "ready" }, { approved: true })).toMatchObject({ tone: "ready", text: "Approved by Triage · ready for you to merge" });
    expect(statusOf({ running: true })).toMatchObject({ text: "Triage running…", live: true });
    expect(statusOf({ waitingForCi: true, verdictSha: "head-1", waitingHeadSha: "head-1" }).text).toBe("Waiting for CI");
    expect(statusOf({ waitingForCi: true, verdictSha: "head-1", waitingHeadSha: "head-2", headSha: "head-1" }).text).toBe("Waiting for CI · new commits since Triage checked");
    expect(statusOf({ state: "new", runId: null, failure: "stuck" }).text).toBe("Couldn't triage: the run stopped responding");
    expect(statusOf({ state: "new", runId: null }).text).toBe("Not triaged yet");
    expect(statusOf({ state: "new", runId: null, draft: true }).text).toBe("Draft");
  });

  test("agrees with the list and the primary: re-review, rechecking, and never asking for a reply when the button approves", () => {
    const requested = check({ check: "no-changes-requested", result: "fail", reason: "a reviewer requested changes" });
    expect(statusOf({ state: "awaiting-review", checks: [requested], reviewAnswered: true })).toMatchObject({ text: "Ready for your re-review" });
    expect(barOf(item({ state: "awaiting-review", checks: [requested], reviewAnswered: true })).primary?.kind).toBe("approve");
    expect(statusOf({ state: "stale" }).text).toBe("Rechecking");
    const draft = check({ check: "not-a-draft", result: "fail", reason: "pull request is a draft" });
    expect(barOf(item({ state: "awaiting-review", checks: [draft] })).primary?.kind).toBe("approve");
    expect(statusOf({ state: "awaiting-review", checks: [draft] }).text).toBe("Waiting for review · 1 thing to fix");
  });

  test("commits Triage has not checked are rechecked, never ready, and never merged from the primary", () => {
    const stale = { state: "ready" as const, verdictSha: "head-1", headSha: "head-2" };
    expect(statusOf(stale, { approved: true })).toMatchObject({ tone: "quiet", text: "New commits since Triage checked · rechecking" });
    const bar = barOf(item(stale));
    expect(bar.primary).toBeNull();
    expect(bar.rest.find((entry) => entry.kind === "merge")).toMatchObject({ blocker: "unchecked-commits", label: "Merge" });
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

  test("waiting on the author counts what they must fix; the maintainer's approval names failing rules", () => {
    expect(statusOf({ state: "needs-author-update", posted: true, checks: [FAIL, check({ check: "ci-green", result: "fail" })] })).toEqual({ tone: "author", text: "Waiting on @ada to fix 2 things", live: false });
    expect(statusOf({ checks: [FAIL] }, { handled: { kind: "changes" } })).toMatchObject({ tone: "author", text: "Waiting on @ada to fix 1 thing" });
    expect(statusOf({ checks: [FAIL] }, { handled: { kind: "approve" } })).toMatchObject({ tone: "you", text: "You approved · 1 rule failing" });
  });
});

test("a pull request turned into a draft after its verdict waits on its author, with no review offered first", () => {
  const drafted = item({ state: "awaiting-review", draft: true });
  expect(statusOf({ state: "awaiting-review", draft: true })).toMatchObject({ tone: "author", text: "Draft · waiting on @ada" });
  expect(barOf(drafted).primary).toBeNull();
});

describe("rowStatus", () => {
  test("CI and drafts first, then what you did, then failures to fix, else the verdict", () => {
    expect(rowStatus(item({ waitingForCi: true, draft: true }), null)).toBe("Waiting for CI");
    expect(rowStatus(item({ draft: true, checks: [FAIL] }), null)).toBe("Draft");
    expect(rowStatus(item({ checks: [FAIL] }), { kind: "approve" })).toBe("Approved");
    expect(rowStatus(item({ state: "blocked", checks: [FAIL, UNSURE] }), null)).toBe("1 to fix");
    expect(rowStatus(item({ state: "ready" }), null)).toBe("Ready");
  });
});

describe("approvedByTriage", () => {
  const approved = (overrides: Partial<SuggestedAction>, pr: Partial<PrItem> = {}) => approvedByTriage(item({
    ...pr,
    actions: [{ list: "pass", index: 0, effectId: "e", kind: "approve", reason: "", target: {}, held: false, status: "done", ...overrides }],
  }));

  test("only the verdict's settled approve Do on the current head counts", () => {
    expect(approved({})).toBe(true);
    expect(approved({ status: "satisfied" })).toBe(true);
    expect(approved({}, { headSha: "head-2" })).toBe(false);
    expect(approved({ status: "failed" })).toBe(false);
    expect(approved({ kind: "labels" })).toBe(false);
    expect(approved({ status: undefined, held: true })).toBe(false);
  });
});

describe("paneBar", () => {
  test("the primary is worded for the state", () => {
    expect(barOf(item({ state: "ready" })).primary).toMatchObject({ kind: "merge", label: "Merge", detail: "into main" });
    expect(barOf(item({ comment: "Please add a test." })).primary).toMatchObject({ kind: "reply", label: "Send feedback", detail: "to @ada" });
    expect(barOf(item({ state: "awaiting-review" })).primary).toMatchObject({ kind: "approve", label: "Approve", detail: null });
    expect(barOf(item({ state: "needs-author-update", posted: true, comment: "Fix it." })).primary).toMatchObject({ kind: "comment", label: "Reply", detail: "to @ada" });
  });

  const held = (effectId: string, kind: SuggestedAction["kind"], target: SuggestedAction["target"]): SuggestedAction => ({ list: "unsure", index: 0, effectId, kind, reason: "", target, held: true });

  test("a held action is the button of its kind; one with no button gets its own", () => {
    const bar = barOf(item({ state: "awaiting-review", actions: [held("e1", "approve", {}), held("e2", "labels", { labels: ["bug"] })] }));
    expect(bar.primary).toMatchObject({ kind: "approve", label: "Approve", held: { key: "e1" } });
    expect(bar.rest.map((entry) => entry.kind)).toEqual(["changes", "comment", "merge", "close", "triage"]);
    expect(bar.dos.map((pending) => pending.label)).toEqual(["Add label bug"]);
  });

  test("a held merge off an unsure list keeps its own button and its warning", () => {
    const bar = barOf(item({ state: "ready", actions: [held("e1", "merge", {})] }));
    expect(bar.primary).toMatchObject({ kind: "merge", held: null });
    expect(bar.dos.map((pending) => pending.label)).toEqual(["Merge (the verdict was unsure, not pass)"]);
  });
});

describe("passedChecks", () => {
  test("a gate that did not match is not a passed check", () => {
    expect(passedChecks([check({ check: "a" }), check({ check: "b", gate: true }), check({ check: "c", gate: true, result: "fail" })]).map((row) => row.check)).toEqual(["a", "b"]);
  });
});

describe("a merge the host blocks", () => {
  const ready = { state: "ready", verdict: "pass", ci: "success" } as const;

  test("a pass free of conflicts that a ruleset holds for a review offers no merge and says why", () => {
    const live = detail({ mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" });
    expect(barOf(item(ready), live).primary?.blocker).toBe("review-required");
    expect(statusOf(ready, { detail: live })).toMatchObject({ tone: "you", text: "Ready, but waiting for a required review" });
  });

  test("other blocks on GitHub and Bitbucket's merge checks hold the merge too", () => {
    expect(statusOf(ready, { detail: detail({ mergeableState: "blocked", reviewDecision: null }) }).text).toBe("Ready, but the branch's rules block the merge");
    expect(statusOf(ready, { detail: detail({ mergeableState: "behind" }) }).text).toBe("Ready, but behind its base branch");
    expect(statusOf(ready, { detail: detail({ mergeableState: "unknown" }) }).text).toBe("Ready, once GitHub has checked for conflicts");
    expect(statusOf(ready, { detail: detail({ canMerge: false, mergeVetoes: ["Needs 2 approvals"] }) }).text).toBe("Ready, but the merge checks say: Needs 2 approvals");
    expect(statusOf(ready, { detail: detail({ mergeableState: "clean" }) }).text).toBe("Ready to merge");
  });

  test("the list's read of the host holds the row and the pane before the pane's own read", () => {
    const mergeBlock = mergeBlockOf({ number: 1, mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" });
    expect(rowStatus(item({ ...ready, mergeBlock }), null)).toBe("Waiting for review");
    expect(statusOf({ ...ready, mergeBlock }).text).toBe("Ready, but waiting for a required review");
    expect(rowStatus(item({ ...ready, mergeBlock: "checking" }), null)).toBe("Checking merge state");
    expect(barOf(item({ ...ready, mergeBlock: "checking" })).primary?.blocker).toBe("mergeability-unknown");
  });

  test("only the host's explicit yes clears the merge", () => {
    expect(mergeBlockOf({ number: 1, mergeable: null, mergeableState: "unknown", reviewDecision: null })).toBe("checking");
    expect(mergeBlockOf({ number: 1, mergeable: true, mergeableState: "draft", reviewDecision: null })).toBe("checking");
    expect(mergeBlockOf({ number: 1, mergeable: null, canMerge: true, mergeVetoes: [] })).toBe("checking");
    expect(mergeBlockOf({ number: 1, mergeable: true, mergeableState: "clean", reviewDecision: null })).toBeNull();
    expect(mergeBlockOf({ number: 1, mergeable: true, mergeableState: "unstable", reviewDecision: null })).toBeNull();
    expect(mergeBlockOf({ number: 1, mergeable: true, canMerge: true, mergeVetoes: [] })).toBeNull();
  });
});
