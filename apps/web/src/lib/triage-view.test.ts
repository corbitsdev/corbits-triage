import { describe, expect, test } from "bun:test";
import type { CheckOutput } from "@corbits/triage-contracts";
import type { HubApproval, MergeVerdict, PrItem } from "./hub-api.ts";
import { approvalHeadline, checkValueText, findPrItem, mergeText } from "./triage-view.ts";

function approval(close: boolean): HubApproval {
  return {
    id: "approval-1",
    runId: "run-1",
    anchorRunId: "run-1",
    status: "pending",
    scope: null,
    toolDefinition: { name: "github_mirror" },
    toolArguments: { repo: "acme/widgets", number: 8, close },
    correlationId: "approval-1",
  };
}

function item(repo: string, number: number): PrItem {
  return {
    key: `${repo}#${number}`,
    repo,
    number,
    title: null,
    author: null,
    authorKind: null,
    draft: null,
    mergeable: null,
    state: "needs-decision",
    priority: null,
    owner: null,
    nextAction: null,
    confidence: null,
    merge: null,
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    verdictSha: null,
    degraded: null,
    needsHuman: true,
    closed: false,
    pendingApprovalId: `approval-${repo}`,
    runId: `run-${repo}`,
    waitingSince: null,
    updatedAt: null,
    posted: false,
    running: false,
    failure: null,
    actions: [],
    href: `/triage/pr/${repo}/${number}`,
  };
}

describe("approvalHeadline", () => {
  test("states explicitly that approving close:true closes the pull request", () => {
    expect(approvalHeadline(approval(true))).toBe(
      "An agent wants to post a triage comment and labels, then close acme/widgets#8",
    );
  });

  test("does not claim an ordinary mirror approval closes the pull request", () => {
    expect(approvalHeadline(approval(false))).toBe(
      "An agent wants to post a triage comment and labels on acme/widgets#8",
    );
  });
});

describe("findPrItem", () => {
  const widgets = item("acme/widgets", 8);
  const gadgets = item("other/gadgets", 8);

  test("matches canonical routes by exact owner, repository, and PR number", () => {
    expect(findPrItem([widgets, gadgets], { owner: "other", repo: "gadgets", number: "8" })).toBe(gadgets);
    expect(findPrItem([widgets, gadgets], { owner: "acme", repo: "widgets", number: "8" })).toBe(widgets);
  });

  test("does not fall back to another repository with the same PR number", () => {
    expect(findPrItem([widgets, gadgets], { owner: "missing", repo: "widgets", number: "8" })).toBeUndefined();
  });
});

describe("mergeText", () => {
  function merge(verdict: MergeVerdict["verdict"], score: number | null, reasons: string[]): { merge: MergeVerdict } {
    return { merge: { verdict, score, threshold: 0.7, reasons } };
  }

  test("ready names no overall score", () => {
    expect(mergeText(merge("ready", 0.82, []))).toBe("Ready to merge");
    expect(mergeText(merge("ready", null, []))).toBe("Ready to merge");
  });

  test("a failing check is named before the threshold", () => {
    expect(mergeText(merge("not-recommended", 0.6, ["Failed: tests are not added or updated", "Score 0.6 is below the threshold 0.7"])))
      .toBe("Merge not recommended · tests are not added or updated");
  });

  test("a low score alone says how sure Triage must be, not the score", () => {
    expect(mergeText(merge("not-recommended", 0.62, ["Score 0.62 is below the threshold 0.7"]))).toBe("Merge not recommended · not sure enough of every answer to recommend merging (needs 70%)");
  });

  test("a degraded verdict says what could not be evaluated", () => {
    expect(mergeText(merge("not-recommended", 0.9, ["Could not evaluate 2 checks", "Failed: mixes unrelated changes"]))).toBe("Merge not recommended · could not evaluate 2 checks");
    expect(mergeText(merge("not-recommended", null, ["Could not evaluate"]))).toBe("Merge not recommended · could not evaluate");
  });

  test("a verdict from before the merge verdict is not evaluated", () => {
    expect(mergeText({ merge: null })).toBe("Not evaluated");
  });
});

describe("checkValueText", () => {
  function value(output: CheckOutput | null, reason: string | null = "", evidence: string[] = []) {
    return checkValueText({ output, reason, evidence });
  }

  test("shows each check's own value against its bar, facts as words, and a state as a state", () => {
    expect(value({ kind: "score", score: 59.00000000000001, passAt: 70, items: ["src/api.ts"] })).toBe("59 / 70 (src/api.ts)");
    expect(value({ kind: "score", score: 9.999999999999998, passAt: 70, items: ["src/api.ts"] }, "", ["src/api.ts"])).toBe("10 / 70");
    expect(value({ kind: "score", score: 20, passAt: 60, items: ["src/api.ts"], unread: ["a.ts", "a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] }, "", ["src/api.ts"])).toBe("20 / 60; couldn't read: a.ts, b.ts, c.ts +2 more");
    expect(value({ kind: "score", score: 10, passAt: 70, items: [{ path: "src/router.ts", added: { start: 40, end: 58 } }, { path: "src/router.ts", removed: { path: "src/router.ts", start: 12, end: 13 } }] })).toBe("10 / 70 (src/router.ts:40-58, src/router.ts (removed lines 12–13))");
    expect(value({ kind: "values", values: { files: 33, lines: 2104 } })).toBe("33 files, 2,104 lines");
    expect(value({ kind: "values", values: { status: "pending" } })).toBe("CI pending");
    expect(value({ kind: "values", values: { holds: false, approvals: 1 } })).toBe("does not hold, 1 approval");
    expect(value({ kind: "met", items: ["src/a.test.ts"] }, "", ["src/a.test.ts"])).toBe("met");
    expect(value({ kind: "not-applicable" })).toBe("not applicable");
    expect(value({ kind: "could-not-check", reason: "file could not be read", items: ["dist/app.js"] }, "not enough evidence to decide")).toBe("couldn't check: file could not be read (dist/app.js)");
    expect(value({ kind: "could-not-check", reason: "decision model unavailable" }, "decision model unavailable")).toBe("couldn't check");
    expect(value(null)).toBeNull();
  });

  test("a score just under its bar never shows the bar", () => {
    expect(value({ kind: "score", score: 69.5, passAt: 70, items: [] })).toBe("69 / 70");
    expect(value({ kind: "score", score: 70, passAt: 70, items: [] })).toBe("70 / 70");
  });
});
