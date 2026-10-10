import { describe, expect, test } from "bun:test";
import { emptyPack, type Action, type CheckRef, type Do } from "@corbits/triage-contracts";
import { doEffectId, evaluateActions, type ActionInput, type SuggestedAction, type SuggestedDo } from "./actions.js";
import type { PrFacts } from "./checks.js";

const facts: PrFacts = {
  repo: "acme/widgets",
  number: 8,
  title: "feat(api): add search",
  author: "octocat",
  tier: "external",
  headSha: "abc",
  state: "open",
  draft: false,
  mergeable: true,
  baseBehindBy: 0,
  checks: "success",
  requestedReviewers: 1,
  reviewers: ["alice"],
  reviewedBy: ["bob"],
  approvals: 1,
  openPrs: [],
  labels: ["api"],
  assignees: ["Bob"],
  event: "opened",
};

const checks: ActionInput["checks"] = [
  { check: "ci", kind: "machine", result: "pass", reason: "", evidence: [] },
  { check: "tests", kind: "model", result: "fail", reason: "", evidence: [] },
  { check: "focused", kind: "model", result: "unconfirmed", reason: "", evidence: [] },
];

function run(actions: Action[], roles: ActionInput["roles"] = {}) {
  return evaluateActions({ facts, checks, pack: { ...emptyPack("acme/widgets"), actions }, roles });
}

function targets(steps: SuggestedAction[]) {
  return steps.map((a) => ("target" in a ? a.target : null));
}

function say(body: string): Do {
  return { kind: "comment", automatic: false, target: { body } };
}

function branching(when: Action["when"], refs: CheckRef[]): Action {
  return { id: "a", when, checks: refs, branches: { yes: [say("yes")], no: [say("no")], unsure: [say("unsure")] } };
}

function always(dos: Do[]): Action {
  return { id: "a", when: "every", checks: [], branches: { always: dos } };
}

describe("evaluateActions", () => {
  test.each<[string, Action, string[]]>([
    ["all pass picks yes", branching(["opened"], ["ci"]), ["yes"]],
    ["any fail picks no", branching(["opened"], ["ci", "tests", "focused"]), ["no"]],
    ["unconfirmed picks unsure", branching(["opened"], ["ci", "focused"]), ["unsure"]],
    ["no checks runs always", always([say("always")]), ["always"]],
    ["an event not in when does nothing", branching(["updated"], ["ci"]), []],
    ["every always matches", branching("every", ["ci"]), ["yes"]],
  ])("%s", (_, action, bodies) => {
    expect(targets(run([action])).map((t) => (t && "body" in t ? t.body : null))).toEqual(bodies);
  });

  test("names the checks behind the branch", () => {
    expect(run([branching(["opened"], ["ci", "tests"])])).toEqual([
      { id: "a", branch: "no", index: 0, effectId: expect.any(String), kind: "comment", automatic: false, target: { body: "no" }, reason: "Tests failed." },
    ]);
  });

  test("skips an action whose check is off in the pack", () => {
    expect(run([branching(["opened"], ["ci", "docs"])])).toEqual([{ id: "a", skipped: true, reason: "Docs is off in this pack." }]);
  });

  test.each<[string, Do, unknown[]]>([
    ["a label already set in another case is omitted", { kind: "labels", automatic: true, target: { from: "list", labels: ["Api"] } }, []],
    ["a partly set label list is kept whole", { kind: "labels", automatic: true, target: { from: "list", labels: ["api", "search"] } }, [{ labels: ["api", "search"] }]],
    ["an assignee already in place in another case is omitted", { kind: "assign", automatic: true, target: { to: "users", users: ["bob"] } }, []],
    [
      "review is requested only from people not yet requested or reviewed, ignoring case",
      { kind: "request-review", automatic: false, target: { to: "users", users: ["OctoCat", "ALICE", "Bob", "carol"] } },
      [{ users: ["carol"], teams: [] }],
    ],
    ["a review request already satisfied is omitted", { kind: "request-review", automatic: false, target: { to: "users", users: ["alice", "bob"] } }, []],
    ["closing an open pull request stands", { kind: "close", automatic: false, target: {} }, [{}]],
  ])("%s", (_, task, expected) => {
    expect(targets(run([always([task])]))).toEqual(expected);
  });

  test("resolves people targets and skips the ones that cannot apply", () => {
    const dos: Do[] = [
      { kind: "request-review", automatic: false, target: { to: "role", role: "leads" } },
      { kind: "request-review", automatic: false, target: { to: "role", role: "ghost" } },
      { kind: "request-review", automatic: false, target: { to: "users", users: ["octocat"] } },
      { kind: "assign", automatic: false, target: { to: "author" } },
      { kind: "assign", automatic: false, target: { to: "teams", teams: ["core"] } },
    ];
    const base = { id: "a", branch: "always", automatic: false } as const;
    const effectId = expect.any(String);
    expect(run([always(dos)], { leads: { users: ["dave", "octocat"], teams: ["@acme/core"] } })).toEqual([
      { ...base, index: 0, effectId, kind: "request-review", target: { users: ["dave"], teams: ["core"] }, reason: "Always applies." },
      { ...base, index: 1, kind: "request-review", skipped: true, reason: "Role ghost is not defined in the repository policy." },
      { ...base, index: 2, kind: "request-review", skipped: true, reason: "No reviewer is left once the author is excluded." },
      { ...base, index: 3, effectId, kind: "assign", target: { users: ["octocat"] }, reason: "Always applies." },
      { ...base, index: 4, kind: "assign", skipped: true, reason: "Assignees must be users and this target names none." },
    ]);
  });

  test("a step keeps its index when steps before it are satisfied or skipped", () => {
    const behind = run([always([
      { kind: "labels", automatic: false, target: { from: "list", labels: ["api"] } },
      { kind: "assign", automatic: false, target: { to: "teams", teams: ["core"] } },
      say("hello"),
    ])]);
    const ref = { repo: "acme/widgets", number: 8, headSha: "abc", actionId: "a", branch: "always", index: 2, kind: "comment", target: { body: "hello" } } as const;
    expect(behind).toEqual([expect.objectContaining({ kind: "assign", index: 1, skipped: true }), expect.objectContaining({ kind: "comment", index: 2, effectId: doEffectId(ref) })]);
  });

  test("a Do inserted earlier by a pack edit does not take the id of the Do that held its index", () => {
    const [before] = run([always([say("hello")])]) as SuggestedDo[];
    const [inserted, moved] = run([always([{ kind: "labels", automatic: false, target: { from: "list", labels: ["search"] } }, say("hello")])]) as SuggestedDo[];
    expect(inserted!.effectId).not.toBe(before!.effectId);
    expect(moved!.effectId).not.toBe(before!.effectId);
  });
});
