import { describe, expect, test } from "bun:test";
import { alwaysHeld, defaultActions, emptyPack, type Do, type PolicyActions, type VerdictWord } from "@corbits/triage-contracts";
import { doEffectId, evaluateActions, holdDos, type ActionInput, type SuggestedAction, type SuggestedDo } from "./actions.js";
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
  checks: "success",
  reviewers: ["alice"],
  reviewedBy: ["bob"],
  approvals: 1,
  labels: ["api"],
  assignees: ["Bob"],
  events: ["opened"],
};

function run(lists: Partial<PolicyActions>, verdict: VerdictWord = "pass", roles: ActionInput["roles"] = {}, events = facts.events) {
  const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), ...lists } };
  return evaluateActions({ facts: { ...facts, events }, checks: [], verdict, reason: "passes the repository's policy", pack, roles });
}

function targets(steps: SuggestedAction[]) {
  return steps.map((a) => ("target" in a ? a.target : null));
}

function say(body: string): Do {
  return { kind: "comment", target: { body } };
}

const SAYS = { pass: [say("pass")], fail: [say("fail")], unsure: [say("unsure")] };

describe("evaluateActions", () => {
  test.each<[string, VerdictWord, PolicyActions["when"], ActionInput["facts"]["events"], string[]]>([
    ["a pass runs the pass list", "pass", ["opened"], ["opened"], ["pass"]],
    ["a fail runs the fail list", "fail", ["opened"], ["opened"], ["fail"]],
    ["an unsure verdict runs the unsure list", "unsure", ["opened"], ["opened"], ["unsure"]],
    ["an event the policy does not name runs nothing", "pass", ["updated"], ["opened"], []],
    ["any of the run's events wakes it", "pass", ["checks"], ["updated", "checks"], ["pass"]],
    ["catch-up wakes it whatever it names", "pass", ["updated"], ["catch-up"], ["pass"]],
  ])("%s", (_, verdict, when, events, bodies) => {
    expect(targets(run({ ...SAYS, when }, verdict, {}, events)).map((t) => (t && "body" in t ? t.body : null))).toEqual(bodies);
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
    expect(targets(run({ pass: [task] }))).toEqual(expected);
  });

  test("resolves people targets and skips the ones that cannot apply", () => {
    const dos: Do[] = [
      { kind: "request-review", target: { to: "role", role: "leads" } },
      { kind: "request-review", target: { to: "role", role: "ghost" } },
      { kind: "request-review", target: { to: "users", users: ["octocat"] } },
      { kind: "assign", target: { to: "author" } },
      { kind: "assign", target: { to: "teams", teams: ["core"] } },
    ];
    const reason = "passes the repository's policy";
    const effectId = expect.any(String);
    expect(run({ pass: dos }, "pass", { leads: { users: ["dave", "octocat"], teams: ["@acme/core"] } })).toEqual([
      { list: "pass", index: 0, effectId, kind: "request-review", target: { users: ["dave"], teams: ["core"] }, reason },
      { list: "pass", index: 1, kind: "request-review", skipped: true, reason: "Role ghost is not defined in the repository settings." },
      { list: "pass", index: 2, kind: "request-review", skipped: true, reason: "No reviewer is left once the author is excluded." },
      { list: "pass", index: 3, effectId, kind: "assign", target: { users: ["octocat"] }, reason },
      { list: "pass", index: 4, kind: "assign", skipped: true, reason: "Assignees must be users and this target names none." },
    ]);
  });

  test("an effect id is stable across hash implementations", () => {
    // Effect ids are stored idempotency keys; this value was produced with node:crypto.
    const ref = { repo: "o/r", number: 8, headSha: "abc123", list: "pass", index: 0, kind: "comment", target: { body: "xy é🚀" } } as const;
    expect(doEffectId(ref)).toBe("7e611cf1aaf437e896b5f4aa1aca8b51f80a15ceb9883911e353cae40cd6fa8f");
  });

  test("a step keeps its index when steps before it are satisfied or skipped", () => {
    const behind = run({ pass: [
      { kind: "labels", target: { from: "list", labels: ["api"] } },
      { kind: "assign", target: { to: "teams", teams: ["core"] } },
      say("hello"),
    ] });
    const ref = { repo: "acme/widgets", number: 8, headSha: "abc", list: "pass", index: 2, kind: "comment", target: { body: "hello" } } as const;
    expect(behind).toEqual([expect.objectContaining({ kind: "assign", index: 1, skipped: true }), expect.objectContaining({ kind: "comment", index: 2, effectId: doEffectId(ref) })]);
  });

  test("a Do inserted earlier by a pack edit does not take the id of the Do that held its index", () => {
    const [before] = run({ pass: [say("hello")] }) as SuggestedDo[];
    const [inserted, moved] = run({ pass: [{ kind: "labels", target: { from: "list", labels: ["search"] } }, say("hello")] }) as SuggestedDo[];
    expect(inserted!.effectId).not.toBe(before!.effectId);
    expect(moved!.effectId).not.toBe(before!.effectId);
  });
});

describe("holdDos", () => {
  test("close or an agent on unsure is held though the pr-triage role holds it; on fail it runs", () => {
    function step(list: VerdictWord, kind: "close" | "agent"): SuggestedDo {
      return { list, index: 0, kind, reason: "", effectId: `e-${list}-${kind}`, target: kind === "close" ? {} : { prompt: "fix", tools: [] } };
    }
    expect(holdDos([step("unsure", "close"), step("fail", "close")], ["close"]).map((action) => "held" in action)).toEqual([true, false]);
    expect(alwaysHeld("unsure", "agent")).toBe(true);
    expect(alwaysHeld("fail", "agent")).toBe(false);
  });
});
