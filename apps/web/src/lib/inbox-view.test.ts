import { describe, expect, test } from "bun:test";
import type { CheckResult, PrItem } from "./hub-api.ts";
import { withoutDecidedDos } from "./pending-dos.ts";
import { allOpen, groupInbox, groupOpen, inboxAction, inboxStatus, inNeedsYou, listCounts, needsYou, notPostedText, postedLabel, primaryAction, readyToMerge, waitingOnOthers, waitsOn, waitsOnIn, type OpenItem } from "./inbox-view.ts";

const READY = new Set(["acme/widgets"]);

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
    failure: null,
    actions: [],
    automatic: [],
    href: "/prs/acme/widgets/1",
    source: "github",
    url: null,
  };
  return Object.assign(base, overrides);
}

describe("groupInbox", () => {
  test("piles every verdict by the action it needs, in mockup order, and only counts pull requests awaiting triage", () => {
    const view = groupInbox([
      item({ key: "a", state: "ready", priority: "P3" }),
      item({ key: "b", state: "needs-author-update", draft: true }),
      item({ key: "c", state: "blocked", priority: "P1" }),
      item({ key: "e", state: "new", runId: null }),
      item({ key: "f", state: "needs-decision", comment: "Looks wanted." }),
      item({ key: "g", state: "stale" }),
      item({ key: "h", state: "new", runId: null, failure: "failed" }),
    ], READY);
    expect(view.groups.map((group) => [group.action, group.items.map((row) => row.key)])).toEqual([
      ["decide", ["f", "g"]],
      ["unblock", ["c"]],
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

  test("a pull request turned into a draft after its verdict leaves Needs you and waits on its author", () => {
    const drafted = item({ state: "awaiting-review", draft: true });
    expect(groupInbox([drafted], READY).groups).toEqual([]);
    expect(waitingOnOthers([{ item: drafted, handled: null }], READY).map((entry) => entry.item.key)).toEqual([drafted.key]);
    expect(waitsOn(drafted, null)).toBe("author");
  });

  test("a repository that cannot be triaged keeps its verdicts as rows but counts nothing as awaiting", () => {
    const view = groupInbox([item({ key: "verdict", state: "ready" }), item({ key: "untriaged", state: "new", runId: null })], new Set());
    expect(view.groups.map((group) => group.items.map((row) => row.key))).toEqual([["verdict"]]);
    expect(view.awaiting).toBe(0);
  });
});

describe("primaryAction", () => {
  test("a decision with a drafted reply posts it; without one it opens the composer", () => {
    expect(primaryAction(item({ comment: "Thanks" }), "decide")).toBe("reply");
    expect(primaryAction(item({}), "decide")).toBe("comment");
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

  test("CI while it is pending, Triage before its first result, else nobody", () => {
    expect(waitsOn(item({ ci: "pending" }), { kind: "approve" })).toBe("ci");
    expect(waitsOn(item({ ci: "success" }), { kind: "approve" })).toBe("nobody");
    expect(waitsOn(item({ state: "new", runId: null }), null)).toBe("triage");
  });
});

describe("requested changes", () => {
  const review: CheckResult = { check: "no-changes-requested", kind: "machine", result: "fail", reason: "a reviewer requested changes", evidence: [], output: null, gate: false };
  const reviewed = item({ state: "needs-author-update", comment: "", checks: [review] });

  const entries = (pr: PrItem): OpenItem[] => [{ item: pr, handled: null }];

  test("leave Needs you and wait on the author until the verdict sees an answer", () => {
    expect(groupInbox([reviewed], READY).groups).toEqual([]);
    expect(listCounts(entries(reviewed), READY)["needs-you"]).toBe(0);
    expect(waitsOn(reviewed, null)).toBe("author");
  });

  test.each([
    ["waiting on the reviewer", "awaiting-review"],
    ["stored before verdicts waited on the reviewer", "needs-author-update"],
  ] as const)("an answered review %s is the maintainer's to re-review", (_, state) => {
    const answered = { ...reviewed, state, reviewAnswered: true };
    expect(groupInbox([answered], READY).groups.map((group) => group.action)).toEqual(["review"]);
    expect(primaryAction(answered, inboxAction(answered))).toBe("approve");
    expect(inboxStatus(answered)).toBe("Waiting for review");
    expect(waitsOn(answered, null)).toBe("maintainer");
  });

  test("a pending approval keeps it in Needs you", () => {
    const pending = { ...reviewed, pendingApprovalId: "a1" };
    expect(listCounts(entries(pending), READY)["needs-you"]).toBe(1);
    expect(waitsOn(pending, null)).toBe("maintainer");
  });

  test("a held action keeps it in Needs you until it is approved, refused or skipped", () => {
    const action = { list: "fail", index: 0, effectId: "e", kind: "request-changes", reason: "Size failed.", target: { body: "Split this." }, held: true } as const;
    const held = { ...reviewed, posted: true, actions: [action] };
    expect(listCounts(entries(held), READY)["needs-you"]).toBe(1);
    expect(listCounts(entries({ ...held, actions: [{ ...action, status: "failed" }] }), READY)["needs-you"]).toBe(1);
    expect(listCounts(entries({ ...held, actions: [{ ...action, status: "done" }] }), READY)["needs-you"]).toBe(0);
    expect(listCounts(entries({ ...held, actions: [{ ...action, status: "skipped" }] }), READY)["needs-you"]).toBe(0);
    expect(listCounts(entries(withoutDecidedDos(held, new Set(["e"]), new Set())), READY)["needs-you"]).toBe(0);
  });
});

describe("postedLabel", () => {
  test("names what the maintainer did, else the verdict's reply", () => {
    expect(postedLabel(item({ posted: true }), { kind: "changes" })).toBe("Requested changes");
    expect(postedLabel(item({ posted: true }), { kind: null })).toBe("Posted");
    expect(postedLabel(item({}), null)).toBeNull();
  });

  test("says why the verdict is not on the host and where to turn posting on", () => {
    expect(notPostedText(item({ notPosted: "no_grants", source: "github" }))).toBe("Not posted on GitHub: Triage may not post here. Allow it under Actions Triage takes on its own on the repository's page.");
    expect(notPostedText(item({}))).toBeNull();
  });
});

describe("groupOpen", () => {
  const open: OpenItem[] = [
    { item: item({ key: "web#1", repo: "acme/web", owner: "ada", priority: "P2" }), handled: null },
    { item: item({ key: "api#2", repo: "acme/api", priority: "P1" }), handled: { kind: "approve" } },
    { item: item({ key: "api#3", repo: "acme/api", owner: "ada", ci: "pending" }), handled: { kind: "approve" } },
    { item: item({ key: "web#4", repo: "acme/web", state: "ready" }), handled: { kind: "changes" } },
  ];

  function keys(grouping: Parameters<typeof groupOpen>[1]) {
    return groupOpen(open, grouping, new Set()).map((pile) => [pile.label, pile.items.map((entry) => entry.item.key)]);
  }

  test("groups every open pull request by repository or owner, in inbox order inside each group", () => {
    expect(keys("repo")).toEqual([["acme/api", ["api#2", "api#3"]], ["acme/web", ["web#1", "web#4"]]]);
    expect(keys("owner")).toEqual([["ada", ["web#1", "api#3"]], ["Unassigned", ["api#2", "web#4"]]]);
  });

  test("groups by who it waits on, in the order the inbox asks", () => {
    expect(keys("waits")).toEqual([
      ["Waits on you", ["web#1"]],
      ["Waits on author", ["web#4"]],
      ["Waits on CI", ["api#3"]],
      ["Waits on nobody", ["api#2"]],
    ]);
  });
});

describe("All open", () => {
  const open: OpenItem[] = [
    { item: item({}), handled: null },
    { item: item({ key: "acme/widgets#2", state: "new", runId: null, authorKind: "FIRST_TIMER" }), handled: null },
    { item: item({ key: "acme/widgets#3", state: "ready", authorKind: "FIRST_TIME_CONTRIBUTOR" }), handled: { kind: "approve" } },
    { item: item({ key: "acme/off#4", repo: "acme/off", authorKind: "FIRST_TIME_CONTRIBUTOR" }), handled: null },
  ];

  test("lists only the open pull requests of repositories with triage enabled", () => {
    expect(allOpen(open, READY).map((entry) => entry.item.key)).toEqual(["acme/widgets#1", "acme/widgets#2", "acme/widgets#3"]);
    expect(allOpen(open, new Set())).toEqual([]);
  });

  test("Needs you and All open count only repositories with triage enabled", () => {
    expect(listCounts(open, READY)).toEqual({ "needs-you": 1, ready: 0, "all-open": 3 });
    expect(listCounts(open, new Set())).toEqual({ "needs-you": 0, ready: 0, "all-open": 0 });
    expect(listCounts([], READY)).toEqual({ "needs-you": 0, ready: 0, "all-open": 0 });
  });

  test("Waiting lists every open pull request outside Needs you, each with what it waits on", () => {
    const waiting: OpenItem[] = [
      ...open,
      { item: item({ key: "acme/widgets#5", state: "needs-author-update", comment: "Please rebase", posted: true }), handled: null },
      { item: item({ key: "acme/widgets#6", state: "new", runId: null, waitingForCi: true }), handled: null },
      { item: item({ key: "acme/widgets#7", running: true }), handled: null },
      { item: item({ key: "acme/widgets#8", waitingForCi: true }), handled: null },
      { item: item({ key: "acme/widgets#9", pendingApprovalId: "a1" }), handled: { kind: "approve" } },
      { item: item({ key: "acme/off#10", repo: "acme/off", pendingApprovalId: "a2" }), handled: null },
    ];
    expect(waitingOnOthers(waiting, READY).map((entry) => [entry.item.key, waitsOnIn(entry, new Set())])).toEqual([
      ["acme/widgets#2", "triage"],
      ["acme/widgets#3", "nobody"],
      ["acme/widgets#5", "author"],
      ["acme/widgets#6", "ci"],
    ]);
    expect(needsYou(waiting, READY).filter((entry) => inNeedsYou(entry.item)).map((entry) => entry.item.key)).toEqual(["acme/widgets#1", "acme/widgets#7", "acme/widgets#8", "acme/widgets#9", "acme/off#10"]);
    expect(listCounts(waiting, READY)["needs-you"] + waitingOnOthers(waiting, READY).length).toBe(allOpen(waiting, READY).length);
  });

  test("an untriaged pull request in a repository that is not set up waits on its setup", () => {
    expect(waitsOnIn({ item: item({ state: "new", runId: null }), handled: null }, READY)).toBe("setup");
  });

  test("Needs you keeps a pending approval of a repository with triage off", () => {
    const held = { item: item({ key: "acme/off#5", repo: "acme/off", pendingApprovalId: "a1" }), handled: null };
    expect(needsYou([...open, held], READY).map((entry) => entry.item.key)).toEqual(["acme/widgets#1", "acme/widgets#2", "acme/off#5"]);
  });
});

describe("Ready", () => {
  function passed(number: number, overrides: Partial<PrItem>): OpenItem {
    const base = { key: `acme/widgets#${number}`, number, state: "ready" as const, verdict: "pass" as const, verdictSha: "head", headSha: "head", ci: "success" as const, mergeable: true };
    return { item: item({ ...base, ...overrides }), handled: null };
  }

  test("lists passes on the current head with CI green and no conflicts, oldest first", () => {
    const open = [
      passed(1, { waitingSince: "2026-10-03T00:00:00.000Z" }),
      passed(2, { waitingSince: "2026-10-02T00:00:00.000Z" }),
      passed(3, { headSha: "newer" }),
      passed(4, { draft: true }),
      passed(5, { ci: "pending" }),
      passed(6, { mergeable: false }),
      passed(7, { verdict: "unsure", state: "awaiting-review" }),
      passed(8, { key: "acme/off#8", repo: "acme/off" }),
    ];
    expect(readyToMerge(open, READY).map((entry) => entry.item.number)).toEqual([2, 1]);
    expect(listCounts(open, READY).ready).toBe(2);
  });

  test("a pass the host would not merge leaves Ready and Merge for where it gets unblocked", () => {
    const open = [passed(1, {}), passed(2, { mergeBlock: "review-required" }), passed(3, { mergeBlock: "behind" }), passed(4, { mergeBlock: "checking" })];
    expect(readyToMerge(open, READY).map((entry) => entry.item.number)).toEqual([1]);
    expect(groupInbox(open.map((entry) => entry.item), READY).groups.map((group) => [group.action, group.items.map((row) => row.number)])).toEqual([
      ["review", [2, 4]],
      ["unblock", [3]],
      ["merge", [1]],
    ]);
  });
});
