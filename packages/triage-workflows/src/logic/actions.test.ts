import { describe, expect, test } from "bun:test";
import { alwaysHeld, emptyPack, type Action, type CheckRef, type Do } from "@corbits/triage-contracts";
import { doEffectId, evaluateActions, holdDos, type ActionInput, type SuggestedAction, type SuggestedDo } from "./actions.js";
import { deriveState, type PrFacts } from "./checks.js";

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
  checks: "success",
  reviewers: ["alice"],
  reviewedBy: ["bob"],
  approvals: 1,
  labels: ["api"],
  assignees: ["Bob"],
  events: ["opened"],
};

const checks: ActionInput["checks"] = [
  { check: "ci-green", kind: "machine", result: "pass", reason: "", evidence: [] },
  { check: "max-files-changed", kind: "machine", result: "fail", reason: "", evidence: [] },
  { check: "focused", kind: "model", result: "unconfirmed", reason: "", evidence: [] },
];

function run(actions: Action[], roles: ActionInput["roles"] = {}) {
  return evaluateActions({ facts, checks, pack: { ...emptyPack("acme/widgets"), actions }, roles });
}

function targets(steps: SuggestedAction[]) {
  return steps.map((a) => ("target" in a ? a.target : null));
}

function say(body: string): Do {
  return { kind: "comment", target: { body } };
}

function branching(when: Action["when"], refs: CheckRef[]): Action {
  return { id: "a", when, checks: refs, branches: { yes: [say("yes")], no: [say("no")], unsure: [say("unsure")] } };
}

function always(dos: Do[]): Action {
  return { id: "a", when: "every", checks: [], branches: { always: dos } };
}

describe("evaluateActions", () => {
  test.each<[string, Action, string[]]>([
    ["all pass picks yes", branching(["opened"], ["ci-green"]), ["yes"]],
    ["any fail picks no", branching(["opened"], ["ci-green", "max-files-changed", "focused"]), ["no"]],
    ["unconfirmed picks unsure", branching(["opened"], ["ci-green", "focused"]), ["unsure"]],
    ["no checks runs always", always([say("always")]), ["always"]],
    ["an event not in when does nothing", branching(["updated"], ["ci-green"]), []],
    ["every always matches", branching("every", ["ci-green"]), ["yes"]],
  ])("%s", (_, action, bodies) => {
    expect(targets(run([action])).map((t) => (t && "body" in t ? t.body : null))).toEqual(bodies);
  });

  test("wakes when its When names any of the run's events", () => {
    const woken = evaluateActions({ facts: { ...facts, events: ["updated", "checks"] }, checks, pack: { ...emptyPack("acme/widgets"), actions: [branching(["checks"], ["ci-green"])] }, roles: {} });
    expect(woken.map((a) => a.branch)).toEqual(["yes"]);
  });

  test("names the checks behind the branch", () => {
    expect(run([branching(["opened"], ["ci-green", "max-files-changed"])])).toEqual([
      { id: "a", branch: "no", index: 0, effectId: expect.any(String), kind: "comment", target: { body: "no" }, reason: "Max files changed failed." },
    ]);
  });

  test("skips an action whose custom check is switched off", () => {
    const pack = { ...emptyPack("acme/widgets"), custom: [{ id: "custom-1", name: "Vendor", group: "code-vs-ci" as const, enabled: false, kind: "rule" as const, rule: "paths-unchanged" as const, globs: ["vendor/**"] }], actions: [branching(["opened"], ["custom-1"])] };
    const { checks: ran } = deriveState(facts, undefined, pack);
    expect(evaluateActions({ facts, checks: ran, pack, roles: {} })).toEqual([{ id: "a", skipped: true, reason: "Vendor is off in this policy." }]);
  });

  test("skips an action whose check is off in the pack", () => {
    expect(run([branching(["opened"], ["ci-green", "docs"])])).toEqual([{ id: "a", skipped: true, reason: "Docs is off in this policy." }]);
  });

  test.each<[string, Do, unknown[]]>([
    ["a label already set in another case is omitted", { kind: "labels", target: { from: "list", labels: ["Api"] } }, []],
    ["a partly set label list is kept whole", { kind: "labels", target: { from: "list", labels: ["api", "search"] } }, [{ labels: ["api", "search"] }]],
    ["an assignee already in place in another case is omitted", { kind: "assign", target: { to: "users", users: ["bob"] } }, []],
    [
      "review is requested only from people not yet requested or reviewed, ignoring case",
      { kind: "request-review", target: { to: "users", users: ["OctoCat", "ALICE", "Bob", "carol"] } },
      [{ users: ["carol"], teams: [] }],
    ],
    ["a review request already satisfied is omitted", { kind: "request-review", target: { to: "users", users: ["alice", "bob"] } }, []],
    ["closing an open pull request stands", { kind: "close", target: {} }, [{}]],
  ])("%s", (_, task, expected) => {
    expect(targets(run([always([task])]))).toEqual(expected);
  });

  test("resolves people targets and skips the ones that cannot apply", () => {
    const dos: Do[] = [
      { kind: "request-review", target: { to: "role", role: "leads" } },
      { kind: "request-review", target: { to: "role", role: "ghost" } },
      { kind: "request-review", target: { to: "users", users: ["octocat"] } },
      { kind: "assign", target: { to: "author" } },
      { kind: "assign", target: { to: "teams", teams: ["core"] } },
    ];
    const base = { id: "a", branch: "always" } as const;
    const effectId = expect.any(String);
    expect(run([always(dos)], { leads: { users: ["dave", "octocat"], teams: ["@acme/core"] } })).toEqual([
      { ...base, index: 0, effectId, kind: "request-review", target: { users: ["dave"], teams: ["core"] }, reason: "Always applies." },
      { ...base, index: 1, kind: "request-review", skipped: true, reason: "Role ghost is not defined in the repository settings." },
      { ...base, index: 2, kind: "request-review", skipped: true, reason: "No reviewer is left once the author is excluded." },
      { ...base, index: 3, effectId, kind: "assign", target: { users: ["octocat"] }, reason: "Always applies." },
      { ...base, index: 4, kind: "assign", skipped: true, reason: "Assignees must be users and this target names none." },
    ]);
  });

  test("an effect id is stable across hash implementations", () => {
    // Effect ids are stored idempotency keys; this value was produced with node:crypto.
    const ref = { repo: "o/r", number: 8, headSha: "abc123", actionId: "tag\ud800", branch: "yes", index: 0, kind: "comment", target: { body: "xy é🚀" } } as const;
    expect(doEffectId(ref)).toBe("fedf9f56631a9cbfed3995eb60019f5799a81b771a2e670df7d5c70a70979dac");
  });

  test("a step keeps its index when steps before it are satisfied or skipped", () => {
    const behind = run([always([
      { kind: "labels", target: { from: "list", labels: ["api"] } },
      { kind: "assign", target: { to: "teams", teams: ["core"] } },
      say("hello"),
    ])]);
    const ref = { repo: "acme/widgets", number: 8, headSha: "abc", actionId: "a", branch: "always", index: 2, kind: "comment", target: { body: "hello" } } as const;
    expect(behind).toEqual([expect.objectContaining({ kind: "assign", index: 1, skipped: true }), expect.objectContaining({ kind: "comment", index: 2, effectId: doEffectId(ref) })]);
  });

  test("a Do inserted earlier by a pack edit does not take the id of the Do that held its index", () => {
    const [before] = run([always([say("hello")])]) as SuggestedDo[];
    const [inserted, moved] = run([always([{ kind: "labels", target: { from: "list", labels: ["search"] } }, say("hello")])]) as SuggestedDo[];
    expect(inserted!.effectId).not.toBe(before!.effectId);
    expect(moved!.effectId).not.toBe(before!.effectId);
  });
});

describe("holdDos", () => {
  test("close on unsure, and close or an agent without checks, are held though the pr-triage role holds them; elsewhere they run", () => {
    const close = (branch: SuggestedDo["branch"]): SuggestedDo => ({ id: "c", branch, index: 0, kind: "close", reason: "", effectId: `e-${branch}`, target: {} });
    expect(holdDos([close("unsure"), close("always"), close("no")], ["close"]).map((action) => "held" in action)).toEqual([true, true, false]);
    expect(alwaysHeld("always", "agent")).toBe(true);
    expect(alwaysHeld("yes", "agent")).toBe(false);
  });
});
