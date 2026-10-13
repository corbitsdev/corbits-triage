import { describe, expect, test } from "bun:test";
import { defaultActions, emptyPack, type Step, type PolicyActions, type VerdictWord } from "@corbits/triage-contracts";
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

function say(body: string): Step {
  return { do: "comment", target: { body } };
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

  test.each<[string, Step, unknown[]]>([
    ["a label already set in another case is omitted", { do: "labels", target: { from: "list", labels: ["Api"] } }, []],
    ["a partly set label list is kept whole", { do: "labels", target: { from: "list", labels: ["api", "search"] } }, [{ labels: ["api", "search"] }]],
    ["an assignee already in place in another case is omitted", { do: "assign", target: { to: "users", users: ["bob"] } }, []],
    [
      "review is requested only from people not yet requested or reviewed, ignoring case",
      { do: "request-review", target: { to: "users", users: ["OctoCat", "ALICE", "Bob", "carol"] } },
      [{ users: ["carol"], teams: [] }],
    ],
    ["a review request already satisfied is omitted", { do: "request-review", target: { to: "users", users: ["alice", "bob"] } }, []],
    ["closing an open pull request stands", { do: "close" }, [{}]],
  ])("%s", (_, task, expected) => {
    expect(targets(run({ pass: [task] }))).toEqual(expected);
  });

  test("resolves people targets and skips the ones that cannot apply", () => {
    const dos: Step[] = [
      { do: "request-review", target: { to: "role", role: "leads" } },
      { do: "request-review", target: { to: "role", role: "ghost" } },
      { do: "request-review", target: { to: "users", users: ["octocat"] } },
      { do: "assign", target: { to: "author" } },
      { do: "assign", target: { to: "teams", teams: ["core"] } },
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
      { do: "labels", target: { from: "list", labels: ["api"] } },
      { do: "assign", target: { to: "teams", teams: ["core"] } },
      say("hello"),
    ] });
    const ref = { repo: "acme/widgets", number: 8, headSha: "abc", list: "pass", index: 2, kind: "comment", target: { body: "hello" } } as const;
    expect(behind).toEqual([expect.objectContaining({ kind: "assign", index: 1, skipped: true }), expect.objectContaining({ kind: "comment", index: 2, effectId: doEffectId(ref) })]);
  });

  test("a step not for the author is skipped with why, and one whose author cannot be told apart is skipped too", () => {
    const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), pass: [
      { ...say("maintainers"), for: "maintainers" },
      { ...say("outside"), for: "external" },
      { ...say("team"), for: { team: "acme/core" } },
      { ...say("named"), for: { users: ["OctoCat"] } },
      { do: "nothing" },
      { ...say("unknown team"), for: { team: "acme/ops" } },
    ] satisfies Step[] } };
    const author = { ...facts, authorKind: "outside" as const, authorTeams: ["acme/core"], authorTeamsUnknown: ["acme/ops"] };
    const ran = evaluateActions({ facts: author, checks: [], verdict: "pass", reason: "passes", pack, roles: {} });
    expect(ran.map((action) => ("skipped" in action ? action.reason : action.index))).toEqual([
      "Not run: the author is outside, not one of maintainers.",
      1,
      2,
      3,
      "Not run: membership of acme/ops is not known.",
    ]);
    const unknownKind = evaluateActions({ facts, checks: [], verdict: "pass", reason: "passes", pack, roles: {} });
    expect(unknownKind[0]).toMatchObject({ skipped: true, reason: "Not run: the author's kind is not known, so it cannot tell whether they are maintainers." });
  });

  test("derived labels name the verdict and each failed rule, and take back the ones that no longer apply", () => {
    const labelled = { ...facts, labels: ["api", "Triage: Needs changes", "triage: fail", "rule: docs", "rule: focused"] };
    const failed = { check: "focused", kind: "model" as const, result: "fail" as const, reason: "mixes", evidence: [], output: { kind: "not-applicable" as const } };
    const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), pass: [{ do: "labels", target: { from: "verdict" } }, { do: "labels", target: { from: "rules" } }] satisfies Step[] } };
    expect(targets(evaluateActions({ facts: labelled, checks: [failed], verdict: "pass", reason: "passes", pack, roles: {} }))).toEqual([
      { labels: ["triage: pass"], unlabel: ["Triage: Needs changes", "triage: fail"] },
      { labels: ["rule: focused"], unlabel: ["rule: docs"] },
    ]);
  });

  test("a Do inserted earlier by a pack edit does not take the id of the Do that held its index", () => {
    const [before] = run({ pass: [say("hello")] }) as SuggestedDo[];
    const [inserted, moved] = run({ pass: [{ do: "labels", target: { from: "list", labels: ["search"] } }, say("hello")] }) as SuggestedDo[];
    expect(inserted!.effectId).not.toBe(before!.effectId);
    expect(moved!.effectId).not.toBe(before!.effectId);
  });
});

describe("holdDos", () => {
  test("close on unsure, and merge on anything but pass, is held though the pr-triage role holds it", () => {
    function step(list: VerdictWord, kind: "close" | "merge"): SuggestedDo {
      return { list, index: 0, kind, reason: "", effectId: `e-${list}-${kind}`, target: {} };
    }
    const steps = [step("unsure", "close"), step("fail", "close"), step("pass", "merge"), step("fail", "merge"), step("unsure", "merge")];
    expect(holdDos(steps, ["close", "merge"]).map((action) => "held" in action)).toEqual([true, false, false, true, true]);
  });
});
