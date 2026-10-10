import { describe, expect, test } from "bun:test";
import type { HubApproval, MergeVerdict, PrItem } from "./hub-api.ts";
import { approvalHeadline, findPrItem, mergeText } from "./triage-view.ts";

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
    degraded: null,
    needsHuman: true,
    closed: false,
    pendingApprovalId: `approval-${repo}`,
    runId: `run-${repo}`,
    waitingSince: null,
    updatedAt: null,
    canClose: true,
    pendingClose: false,
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

  test("ready shows the score against the threshold, or rules only", () => {
    expect(mergeText(merge("ready", 0.82, []))).toBe("Ready to merge · score 82 (threshold 70)");
    expect(mergeText(merge("ready", null, []))).toBe("Ready to merge · rules only");
  });

  test("a failing check is named before the score", () => {
    expect(mergeText(merge("not-recommended", 0.6, ["Failed: tests are not added or updated", "Score 0.6 is below the threshold 0.7"])))
      .toBe("Merge not recommended · tests are not added or updated");
  });

  test("a low score alone shows the score against the threshold", () => {
    expect(mergeText(merge("not-recommended", 0.62, ["Score 0.62 is below the threshold 0.7"]))).toBe("Merge not recommended · score 62 is below the threshold 70");
  });

  test("a degraded verdict says what could not be evaluated", () => {
    expect(mergeText(merge("not-recommended", 0.9, ["Could not evaluate 2 checks", "Failed: mixes unrelated changes"]))).toBe("Merge not recommended · could not evaluate 2 checks");
    expect(mergeText(merge("not-recommended", null, ["Could not evaluate"]))).toBe("Merge not recommended · could not evaluate");
  });

  test("a verdict from before the merge verdict is not evaluated", () => {
    expect(mergeText({ merge: null })).toBe("Not evaluated");
  });
});
