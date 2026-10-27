import { describe, expect, test } from "bun:test";
import { emptyPack, type CheckPack } from "@corbits/triage-contracts";
import type { CheckResult, GithubPullDetail, PrItem, SuggestedAction } from "./hub-api.ts";
import { mergeBlockOf, paneFacts } from "./inbox-pane.ts";
import type { HandledMark } from "./inbox-view.ts";
import { heldChoices, paneBar, paneProblems, paneStatus, passedChecks, rowStatus, statusText, type StatusInput } from "./pane-report.ts";

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
    automatic: [],
    href: "/prs/acme/widgets/1",
    source: "github",
    url: null,
  };
  return Object.assign(base, overrides);
}

function check(overrides: Partial<CheckResult>): CheckResult {
  return { check: "max-files-changed", kind: "machine", result: "pass", reason: null, evidence: [], output: null, gate: false, ...overrides };
}

const FAIL = check({ check: "docs", kind: "model", result: "fail", reason: "the new retry path is not documented", evidence: ["retry.rs:40-49"], output: { kind: "score", score: 20, passAt: 70, items: [{ path: "retry.rs", added: { start: 40, end: 49 } }] } });
const UNSURE = check({ check: "focused", kind: "model", result: "unconfirmed", reason: "not sure the old job can go", output: { kind: "score", score: 50, passAt: 70, items: [] } });
const CANT = check({ check: "no-merge-conflicts", result: "unconfirmed", reason: "mergeability not yet computed", output: { kind: "could-not-check", reason: "mergeability not yet computed" } });
const RELEASE_NOTES = check({ check: "release-notes", result: "fail", reason: "the description does not contain Release notes" });
const PACK: CheckPack = {
  ...emptyPack("acme/widgets"),
  custom: [{ id: "release-notes", name: "Release notes describe the user-facing change", group: "pull-request", kind: "text", fields: ["description"], failWhen: "not-contains", phrases: ["Release notes"] }],
};

function failed(id: string): CheckResult {
  return check({ check: id, result: "fail" });
}

function barOf(pr: PrItem, detail?: GithubPullDetail, readOnly = false) {
  return paneBar({ item: pr, facts: paneFacts(pr, detail), readOnly, busy: false }, "main", pr.author);
}

function statusOf(overrides: Partial<PrItem>, input: Partial<Omit<StatusInput, "item">> = {}) {
  return paneStatus({ item: item(overrides), detail: undefined, handled: null, pack: null, ...input });
}

function detail(pr: Partial<GithubPullDetail["pr"]>): GithubPullDetail {
  const base: GithubPullDetail["pr"] = { number: 1, title: "Fix", body: null, shownBody: "", state: "open", merged: false, draft: false, author: "ada", sha: "head-1", base: "main", mergeable: true, requestedReviewers: 0, additions: 1, deletions: 1, changedFiles: 1, labels: [], createdAt: "2026-09-30T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  return {
    pr: Object.assign(base, pr),
    files: [], commits: [], comments: [], issues: [], checks: [], reviews: [],
  };
}

describe("paneProblems", () => {
  test("lists only what is in the way, failures first, with cited lines apart from other evidence", () => {
    const gate = check({ check: "custom-1", result: "fail", gate: true });
    const size = check({ check: "max-files-changed", result: "fail", reason: "pull request is over the files limit", evidence: ["31 files (max 30)"], output: { kind: "values", values: { files: 31 } } });
    const problems = paneProblems([CANT, check({}), UNSURE, gate, FAIL, size], null);
    expect(problems.map((problem) => [problem.check.check, problem.severity])).toEqual([["docs", "fail"], ["max-files-changed", "fail"], ["focused", "unsure"], ["no-merge-conflicts", "cant"]]);
    expect(problems[0]).toMatchObject({ text: "The new retry path is not documented", cited: ["retry.rs:40-49"], notes: [] });
    expect(problems[1]).toMatchObject({ cited: [], notes: ["31 files (max 30)"] });
  });

  test("an undecided gate could not be checked; a check from before outputs is unsure only when a model asked it", () => {
    expect(paneProblems([check({ result: "unconfirmed", gate: true })], null)[0]?.severity).toBe("cant");
    expect(paneProblems([check({ kind: "model", result: "unconfirmed" })], null)[0]).toMatchObject({ severity: "unsure", text: null });
    expect(paneProblems([check({ result: "unconfirmed" })], null)[0]?.severity).toBe("cant");
  });
});

describe("status line and row", () => {
  const feedback = "Please add a test.";
  const requested = check({ check: "no-changes-requested", result: "fail", reason: "a reviewer requested changes" });
  const asked: CheckPack = { ...emptyPack("acme/widgets"), checks: { "linked-issue": { enabled: true, tracker: "github", onFail: "ask" } } };

  /** Each case through both, in the one order: what the pane says, and the row's shortened words. */
  const CASES: Array<[string, Partial<PrItem>, string, string, CheckPack?, HandledMark?]> = [
    ["closed", { closed: true, checks: [FAIL] }, "Closed", "Closed"],
    ["running", { running: true }, "Triage running…", "Running"],
    ["waiting for CI", { waitingForCi: true, checks: [FAIL] }, "Waiting for CI", "Waiting for CI"],
    ["a failed run that is also a draft", { state: "new", runId: null, failure: "stuck", draft: true, checks: [FAIL] }, "Couldn't triage: the run stopped responding · use Triage again in More", "Couldn't triage"],
    ["a failed run", { state: "new", runId: null, failure: "stuck" }, "Couldn't triage: the run stopped responding", "Couldn't triage"],
    ["a draft that is rechecking", { state: "stale", draft: true }, "Draft · waiting on @ada", "Draft"],
    ["rechecking with commits Triage has not checked", { state: "stale", headSha: "head-2" }, "Rechecking", "Rechecking"],
    ["a draft with a failed rule", { state: "awaiting-review", draft: true, checks: [FAIL] }, "Draft · waiting on @ada", "Draft"],
    ["stale", { state: "stale", checks: [FAIL], comment: feedback }, "Rechecking", "Rechecking"],
    ["new", { state: "new", runId: null }, "Not triaged yet", "Not triaged yet"],
    ["commits Triage has not checked", { state: "blocked", checks: [FAIL], headSha: "head-2" }, "New commits since Triage checked · rechecking", "Rechecking"],
    ["a re-review with a rule to decide", { state: "awaiting-review", reviewAnswered: true, checks: [requested, UNSURE] }, "Re-review: @ada updated it · still to decide: Focused", "Re-review"],
    ["a re-review with nothing open", { state: "awaiting-review", reviewAnswered: true, checks: [requested] }, "Re-review: @ada updated it · all rules met", "Re-review"],
    ["a rule Triage wasn't sure of, before the button", { checks: [FAIL, UNSURE], comment: feedback }, "Decide: Focused (Triage wasn't sure)", "Decide: Focused"],
    ["a rule the policy asks about", { checks: [failed("linked-issue")], comment: feedback }, "Decide: Linked issue (your policy asks you)", "Decide: Linked issue", asked],
    ["both kinds to decide", { checks: [failed("linked-issue"), UNSURE] }, "Decide: Linked issue +1 more (see why below)", "Decide: Linked issue +1 more", asked],
    ["Send feedback", { checks: [FAIL, failed("linked-issue"), failed("ci-green")], comment: feedback }, "Ask @ada to fix: Docs, Linked issue +1 more", "Ask to fix: Docs +2 more"],
    ["Send feedback with nothing failed", { comment: feedback }, "Send feedback to @ada", "Send feedback"],
    ["Request changes", { state: "blocked", checks: [FAIL] }, "Request changes from @ada: Docs", "Request changes: Docs"],
    ["Request changes with no failed rule", { state: "blocked" }, "Request changes from @ada", "Request changes"],
    ["Approve with every rule met", { state: "awaiting-review" }, "Review and approve", "Review"],
    ["Approve with a rule failing", { state: "awaiting-review", checks: [failed("linked-issue")] }, "Approve anyway, or ask @ada to fix: Linked issue", "Review: Linked issue"],
    ["Reply", {}, "Reply to @ada", "Reply"],
    ["Reply with a rule failing and no feedback drafted", { checks: [FAIL] }, "Reply to @ada · not met: Docs", "Reply: Docs"],
    ["Merge", { state: "ready", verdict: "pass" }, "Ready to merge", "Ready to merge"],
    ["Merge with a rule failing", { state: "ready", verdict: "pass", checks: [FAIL, failed("ci-green")] }, "Ready to merge · still not met: Docs +1 more", "Ready to merge: not met Docs +1 more"],
    ["Merge with a rule that couldn't be checked", { state: "ready", verdict: "pass", checks: [CANT] }, "Couldn't check Merge conflicts · use Triage again in More", "Couldn't check: Merge conflicts"],
    ["Send feedback with nothing failed and a rule that couldn't be checked", { comment: feedback, checks: [CANT] }, "Couldn't check Merge conflicts · use Triage again in More", "Couldn't check: Merge conflicts"],
    ["Request changes with nothing failed and a rule that couldn't be checked", { state: "blocked", checks: [CANT] }, "Couldn't check Merge conflicts · use Triage again in More", "Couldn't check: Merge conflicts"],
    ["Approve with nothing failed and a rule that couldn't be checked", { state: "awaiting-review", checks: [CANT] }, "Couldn't check Merge conflicts · use Triage again in More", "Couldn't check: Merge conflicts"],
    ["a failed rule before one that couldn't be checked", { checks: [FAIL, CANT], comment: feedback }, "Ask @ada to fix: Docs", "Ask to fix: Docs"],
    ["Merge held by the host, as the list read it", { state: "ready", verdict: "pass", mergeBlock: "behind" }, "Can't merge yet: behind its base branch", "Behind base"],
    ["Triage's own pull request, merged rather than approved", { byTriage: true, state: "awaiting-review" }, "Ready to merge", "Ready to merge"],
    ["Triage's own pull request with no button and a rule failing", { byTriage: true, state: "blocked", checks: [FAIL] }, "Not met: Docs", "Not met: Docs"],
    ["Triage's own pull request held by the host", { byTriage: true, state: "blocked", mergeBlock: "behind" }, "Blocked: behind its base branch", "Blocked"],
    ["your approval of a re-review, before the re-review, leaving out the change you requested", { state: "awaiting-review", reviewAnswered: true, checks: [requested] }, "You approved", "Approved", undefined, { kind: "approve" }],
    ["your approval with Merge the main button", { state: "ready", verdict: "pass" }, "You approved · ready to merge", "Approved", undefined, { kind: "approve" }],
    ["your approval with a rule failing", { state: "blocked", checks: [FAIL, failed("ci-green"), requested] }, "You approved · still not met: Docs +1 more", "Approved", undefined, { kind: "approve" }],
    ["your approval with a rule to decide", { checks: [UNSURE] }, "You approved · still to decide: Focused", "Approved", undefined, { kind: "approve" }],
    ["your approval with a rule that couldn't be checked", { checks: [CANT] }, "You approved · couldn't check: Merge conflicts", "Approved", undefined, { kind: "approve" }],
    ["your approval on the author's turn", { state: "needs-author-update", posted: true }, "You approved · waiting on @ada", "Approved", undefined, { kind: "approve" }],
    ["your approval with the host holding the merge", { state: "ready", verdict: "pass", mergeBlock: "behind" }, "You approved · can't merge yet: behind its base branch", "Approved", undefined, { kind: "approve" }],
    ["what you did, recorded without its kind", { state: "awaiting-review" }, "Review and approve", "Waiting for review", undefined, { kind: null }],
    ["the author's turn", { state: "needs-author-update", posted: true, checks: [FAIL, failed("ci-green")] }, "Waiting on @ada to fix: Docs +1 more", "Waiting on @ada"],
    ["the author's turn with a rule to decide", { state: "needs-author-update", posted: true, checks: [FAIL, UNSURE] }, "Decide: Focused (Triage wasn't sure)", "Decide: Focused"],
    ["a rule that couldn't be checked", { checks: [CANT, check({ check: "ci-green", result: "unconfirmed" })] }, "Couldn't check Merge conflicts +1 more · use Triage again in More", "Couldn't check: Merge conflicts +1 more"],
    ["a custom rule from the pack", { state: "blocked", checks: [RELEASE_NOTES] }, "Request changes from @ada: Release notes describe the user-facing change", "Request changes: Release notes describe the user-facing change", PACK],
    ["a custom rule without a pack", { state: "blocked", checks: [RELEASE_NOTES] }, "Request changes from @ada: release-notes", "Request changes: release-notes"],
  ];

  test.each(CASES)("the row says what the pane says, shortened: %s", (_, overrides, pane, row, pack = undefined, handled = undefined) => {
    const saved = pack ?? null;
    const mark = handled ?? null;
    expect(statusOf(overrides, { pack: saved, handled: mark }).text).toBe(pane);
    expect(statusText(rowStatus(item(overrides), mark, saved))).toBe(row);
  });

  test("the row keeps the count apart, so it is never cut off", () => {
    expect(rowStatus(item({ checks: [FAIL, failed("linked-issue"), failed("ci-green")], comment: feedback }), null, null)).toEqual({ text: "Ask to fix: Docs", more: 2 });
  });

  test("only the host's own read changes the pane: what holds the merge, and what holds a pull request with nothing to fix", () => {
    const ready = { state: "ready", verdict: "pass" } as const;
    expect(statusOf(ready, { detail: detail({ draft: true }) }).text).toBe("Can't merge yet: it's a draft");
    expect(statusOf(ready, { detail: detail({ mergeable: false }) }).text).toBe("Can't merge yet: it has conflicts");
    expect(statusOf({ ...ready, source: "bitbucket-datacenter" }, { detail: detail({ mergeable: null }) }).text).toBe("Can't merge yet: Bitbucket hasn't checked for conflicts");
    expect(statusOf({ state: "blocked" }, { detail: detail({ mergeableState: "behind" }) }).text).toBe("Request changes from @ada: behind its base branch");
  });

  test("what you did shows on the row; the pane says where that leaves it", () => {
    expect(statusOf({ state: "ready", verdict: "pass" }, { handled: { kind: "approve" } })).toMatchObject({ tone: "ready", text: "You approved · ready to merge" });
    expect(statusOf({ state: "blocked", checks: [FAIL] }, { handled: { kind: "changes" } })).toMatchObject({ tone: "author", text: "Waiting on @ada to fix: Docs" });
    expect(rowStatus(item({ state: "blocked", checks: [FAIL] }), { kind: "changes" }, null).text).toBe("Requested changes");
    expect(statusOf({ checks: [FAIL] }, { detail: detail({ merged: true, state: "closed" }) }).text).toBe("Merged");
    expect(statusOf({}, { handled: { kind: "merge" } }).text).toBe("Merged");
  });

  test("commits Triage has not checked are never merged from the primary", () => {
    const bar = barOf(item({ state: "ready", verdictSha: "head-1", headSha: "head-2" }));
    expect(bar.primary).toBeNull();
    expect(bar.rest.find((entry) => entry.kind === "merge")).toMatchObject({ blocker: "unchecked-commits", label: "Merge" });
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

  test("a held action the primary carries out is still listed, so it can be read and hidden", () => {
    const merge = barOf(item({ state: "ready", verdict: "pass", actions: [{ ...held("e1", "merge", {}), list: "pass" }] }));
    expect(merge.primary).toMatchObject({ kind: "merge", held: { key: "e1" } });
    expect(heldChoices(merge)).toMatchObject([{ pending: { key: "e1" }, entry: { kind: "merge" } }]);

    const approve = barOf(item({ state: "awaiting-review", actions: [held("e2", "approve", {})] }));
    expect(approve.primary).toMatchObject({ kind: "approve", held: { key: "e2" } });
    expect(heldChoices(approve)).toMatchObject([{ pending: { key: "e2" }, entry: { kind: "approve" } }]);
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
    expect(statusOf(ready, { detail: live })).toMatchObject({ tone: "you", text: "Can't merge yet: waiting for a required review" });
  });

  test("other blocks on GitHub and Bitbucket's merge checks hold the merge too", () => {
    expect(statusOf(ready, { detail: detail({ mergeableState: "blocked", reviewDecision: null }) }).text).toBe("Can't merge yet: the branch's rules block the merge");
    expect(statusOf(ready, { detail: detail({ mergeableState: "behind" }) }).text).toBe("Can't merge yet: behind its base branch");
    expect(statusOf(ready, { detail: detail({ mergeableState: "unknown" }) }).text).toBe("Can't merge yet: GitHub hasn't checked for conflicts");
    expect(statusOf(ready, { detail: detail({ canMerge: false, mergeVetoes: ["Needs 2 approvals"] }) }).text).toBe("Can't merge yet: the merge checks say: Needs 2 approvals");
    expect(statusOf(ready, { detail: detail({ mergeableState: "clean" }) }).text).toBe("Ready to merge");
  });

  test("the list's read of the host holds the row and the pane before the pane's own read", () => {
    const mergeBlock = mergeBlockOf({ number: 1, mergeable: true, mergeableState: "blocked", reviewDecision: "REVIEW_REQUIRED" });
    expect(rowStatus(item({ ...ready, mergeBlock }), null, null).text).toBe("Waiting for review");
    expect(statusOf({ ...ready, mergeBlock }).text).toBe("Can't merge yet: waiting for a required review");
    expect(rowStatus(item({ ...ready, mergeBlock: "checking" }), null, null).text).toBe("Checking merge state");
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
