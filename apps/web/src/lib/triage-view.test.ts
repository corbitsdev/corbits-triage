import { describe, expect, test } from "bun:test";
import type { HubApproval, PrItem } from "./hub-api.ts";
import { approvalHeadline, findPrItem, verdictText } from "./triage-view.ts";

function approval(): HubApproval {
  return {
    id: "approval-1",
    tenantId: "tenant",
    runId: "run-1",
    anchorRunId: "run-1",
    agentAddress: "run-1",
    status: "pending",
    scope: null,
    toolDefinition: { name: "github_mirror" },
    toolArguments: { repo: "acme/widgets", number: 8 },
    correlationId: "approval-1",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: "2026-03-10T00:00:00.000Z",
    updatedAt: "2026-03-10T00:00:00.000Z",
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
    byTriage: false,
    draft: null,
    mergeable: null,
    mergeBlock: null,
    state: "needs-decision",
    priority: null,
    owner: null,
    nextAction: null,
    verdict: null,
    score: null,
    reasons: [],
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
  test("names the pull request a mirror approval writes to", () => {
    expect(approvalHeadline(approval())).toBe(
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

describe("verdictText", () => {
  test("names the verdict, how likely it passes when the judge was asked, and the first reason", () => {
    expect(verdictText({ verdict: "pass", score: 0.82, reasons: [] })).toBe("Pass · 82% likely to pass");
    expect(verdictText({ verdict: "fail", score: null, reasons: ["Required checks are failing: build", "documentation is not updated"] })).toBe("Fail · required checks are failing: build");
    expect(verdictText({ verdict: null, score: null, reasons: [] })).toBe("Not evaluated");
  });
});
