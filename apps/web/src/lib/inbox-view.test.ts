import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import { groupInbox, hasDraftComment, inboxAction, inboxStatus, primaryAction } from "./inbox-view.ts";

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
    failure: null,
    href: "/prs/acme/widgets/1",
    ...overrides,
  };
}

describe("groupInbox", () => {
  test("piles pull requests by the action they need, in mockup order, and folds the rest", () => {
    const view = groupInbox([
      item({ key: "a", state: "ready", priority: "P3" }),
      item({ key: "b", state: "needs-author-update" }),
      item({ key: "c", state: "blocked", priority: "P1" }),
      item({ key: "d", state: "awaiting-review", canClose: true }),
      item({ key: "e", state: "new" }),
      item({ key: "f", state: "needs-decision", comment: "Looks wanted." }),
    ]);
    expect(view.groups.map((group) => [group.action, group.items.map((row) => row.key)])).toEqual([
      ["decide", ["f"]],
      ["unblock", ["c"]],
      ["duplicate", ["d"]],
      ["merge", ["a"]],
    ]);
    expect(view.waiting.map((row) => row.key)).toEqual(["b", "e"]);
  });

  test("sorts by priority, then humans first, then longest waiting", () => {
    const view = groupInbox([
      item({ key: "late", priority: "P2", waitingSince: "2026-10-05T00:00:00.000Z" }),
      item({ key: "early", priority: "P2", waitingSince: "2026-10-01T00:00:00.000Z" }),
      item({ key: "human", priority: "P2", needsHuman: true, waitingSince: "2026-10-06T00:00:00.000Z" }),
      item({ key: "urgent", priority: "P1", waitingSince: "2026-10-07T00:00:00.000Z" }),
    ]);
    expect(view.groups[0]?.items.map((row) => row.key)).toEqual(["urgent", "human", "early", "late"]);
  });

  test("a running pull request keeps its previous verdict's pile and reads Running", () => {
    const view = groupInbox([item({ key: "rerun", running: true }), item({ key: "first", state: "new", running: true })]);
    expect(view.groups.map((group) => [group.action, group.items.map((row) => [row.key, inboxStatus(row)])])).toEqual([["decide", [["rerun", "Running"]]]]);
    expect(view.waiting.map((row) => [row.key, inboxStatus(row)])).toEqual([["first", "Running"]]);
  });
});

describe("hasDraftComment", () => {
  test("a real draft is a draft", () => {
    expect(hasDraftComment("approve this")).toBe(true);
  });

  test("null and empty are not drafts", () => {
    expect(hasDraftComment(null)).toBe(false);
    expect(hasDraftComment("")).toBe(false);
  });

  test("whitespace-only is not a draft", () => {
    expect(hasDraftComment("   ")).toBe(false);
  });
});

describe("primaryAction", () => {
  test("a decision with a drafted reply posts it; without one it opens the composer", () => {
    expect(primaryAction(item({ comment: "Thanks" }), "decide")).toBe("reply");
    expect(primaryAction(item({}), "decide")).toBe("comment");
    expect(inboxAction(item({ state: "ready", canClose: true }))).toBe("duplicate");
  });

  test("a pull request outside the piles posts its draft, and an empty draft is no draft", () => {
    expect(primaryAction(item({ state: "needs-author-update", comment: "Please rebase" }), null)).toBe("reply");
    expect(primaryAction(item({ state: "needs-author-update" }), null)).toBeNull();
    expect(primaryAction(item({ state: "needs-author-update", comment: "" }), null)).toBeNull();
    expect(primaryAction(item({ comment: "" }), "decide")).toBe("comment");
  });
});
