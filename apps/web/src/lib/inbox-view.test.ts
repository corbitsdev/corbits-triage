import { describe, expect, test } from "bun:test";
import type { PrItem } from "./hub-api.ts";
import { groupInbox, hasDraftComment, inboxAction, inboxStatus, postedLabel, primaryAction, waitsOn } from "./inbox-view.ts";

const READY = new Set(["acme/widgets"]);

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
    updatedAt: null,
    ci: null,
    headSha: null,
    activityAt: null,
    canClose: false,
    pendingClose: false,
    posted: false,
    running: false,
    failure: null,
    actions: [],
    href: "/prs/acme/widgets/1",
    ...overrides,
  };
}

describe("groupInbox", () => {
  test("piles every verdict by the action it needs, in mockup order, and only counts pull requests awaiting triage", () => {
    const view = groupInbox([
      item({ key: "a", state: "ready", priority: "P3" }),
      item({ key: "b", state: "needs-author-update", draft: true }),
      item({ key: "c", state: "blocked", priority: "P1" }),
      item({ key: "d", state: "awaiting-review", canClose: true }),
      item({ key: "e", state: "new", runId: null }),
      item({ key: "f", state: "needs-decision", comment: "Looks wanted." }),
      item({ key: "g", state: "stale" }),
      item({ key: "h", state: "new", runId: null, failure: "failed" }),
    ], READY);
    expect(view.groups.map((group) => [group.action, group.items.map((row) => row.key)])).toEqual([
      ["decide", ["f", "g"]],
      ["unblock", ["c", "b"]],
      ["duplicate", ["d"]],
      ["merge", ["a"]],
      ["failed", ["h"]],
    ]);
    expect(view.awaiting).toBe(1);
    expect(primaryAction(item({ state: "new", runId: null, failure: "failed" }), "failed")).toBe("triage");
  });

  test("sorts by priority, then humans first, then longest waiting", () => {
    const view = groupInbox([
      item({ key: "late", priority: "P2", waitingSince: "2026-10-05T00:00:00.000Z" }),
      item({ key: "early", priority: "P2", waitingSince: "2026-10-01T00:00:00.000Z" }),
      item({ key: "human", priority: "P2", needsHuman: true, waitingSince: "2026-10-06T00:00:00.000Z" }),
      item({ key: "urgent", priority: "P1", waitingSince: "2026-10-07T00:00:00.000Z" }),
    ], READY);
    expect(view.groups[0]?.items.map((row) => row.key)).toEqual(["urgent", "human", "early", "late"]);
  });

  test("a running pull request keeps its previous verdict's pile and reads Running", () => {
    const view = groupInbox([item({ key: "rerun", running: true }), item({ key: "first", state: "new", running: true })], READY);
    expect(view.groups.map((group) => [group.action, group.items.map((row) => [row.key, inboxStatus(row)])])).toEqual([["decide", [["rerun", "Running"]]]]);
    expect(view.awaiting).toBe(1);
  });

  test("a repository that cannot be triaged keeps its verdicts as rows but counts nothing as awaiting", () => {
    const view = groupInbox([item({ key: "verdict", state: "ready" }), item({ key: "untriaged", state: "new", runId: null })], new Set());
    expect(view.groups.map((group) => group.items.map((row) => row.key))).toEqual([["verdict"]]);
    expect(view.awaiting).toBe(0);
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

  test("an author's verdict sends its unposted reply and has nothing left once the mirror posted it", () => {
    expect(primaryAction(item({ state: "needs-author-update", comment: "Please rebase" }), "unblock")).toBe("reply");
    expect(primaryAction(item({ state: "needs-author-update", comment: "" }), "unblock")).toBe("comment");
    expect(primaryAction(item({ state: "needs-author-update", comment: "Please rebase", posted: true }), "unblock")).toBeNull();
    expect(primaryAction(item({ state: "blocked", posted: true }), "unblock")).toBe("changes");
    expect(primaryAction(item({ comment: "" }), "decide")).toBe("comment");
  });
});

describe("waitsOn", () => {
  test("the maintainer while in Needs you or while an approval is pending", () => {
    expect(waitsOn(item({}), null)).toBe("maintainer");
    expect(waitsOn(item({ state: "ready", pendingApprovalId: "a1" }), { kind: "approve" })).toBe("maintainer");
  });

  test("the author for a draft, a verdict that needs an update, or requested changes, a reply or a comment", () => {
    expect(waitsOn(item({ draft: true }), { kind: "approve" })).toBe("author");
    expect(waitsOn(item({ state: "needs-author-update" }), { kind: null })).toBe("author");
    for (const kind of ["changes", "reply", "comment"] as const) expect(waitsOn(item({ ci: "pending" }), { kind })).toBe("author");
  });

  test("CI while it is pending, else nobody", () => {
    expect(waitsOn(item({ ci: "pending" }), { kind: "approve" })).toBe("ci");
    expect(waitsOn(item({ ci: "success" }), { kind: "approve" })).toBe("nobody");
    expect(waitsOn(item({ state: "new", runId: null }), null)).toBe("nobody");
  });
});

describe("postedLabel", () => {
  test("names what the maintainer did, else the verdict's reply", () => {
    expect(postedLabel(item({ posted: true }), { kind: "changes" })).toBe("Requested changes");
    expect(postedLabel(item({ posted: true }), { kind: null })).toBe("Posted");
    expect(postedLabel(item({}), null)).toBeNull();
  });
});
