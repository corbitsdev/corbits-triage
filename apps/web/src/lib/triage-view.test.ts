import { describe, expect, test } from "bun:test";
import type { HubApproval, PrItem } from "./hub-api.ts";
import { approvalHeadline, findPrItem } from "./triage-view.ts";

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
    evidence: [],
    checks: [],
    labels: [],
    comment: null,
    sha: null,
    degraded: null,
    needsHuman: true,
    pendingApprovalId: `approval-${repo}`,
    runId: `run-${repo}`,
    waitingSince: null,
    canClose: true,
    pendingClose: false,
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
