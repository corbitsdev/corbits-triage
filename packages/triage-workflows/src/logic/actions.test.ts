import { describe, expect, test } from "bun:test";
import { defaultActions, emptyPack, type Step, type PolicyActions, type VerdictWord } from "@corbits/triage-contracts";
import { doEffectId, evaluateActions, heldApprovals, holdDos, type ActionInput, type SuggestedAction, type SuggestedDo } from "./actions.js";
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

function run(lists: Partial<PolicyActions>, verdict: VerdictWord = "pass", events = facts.events) {
  const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), ...lists } };
  return evaluateActions({ facts: { ...facts, events }, checks: [], verdict, reason: "passes the repository's policy", pack });
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
    expect(targets(run({ ...SAYS, when }, verdict, events)).map((t) => (t && "body" in t ? t.body : null))).toEqual(bodies);
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
      { do: "request-review", target: { to: "teams", teams: ["@acme/core", "other/x"] } },
      { do: "request-review", target: { to: "users", users: ["octocat"] } },
      { do: "assign", target: { to: "author" } },
      { do: "assign", target: { to: "teams", teams: ["core"] } },
    ];
    const reason = "passes the repository's policy";
    const effectId = expect.any(String);
    expect(run({ pass: dos })).toEqual([
      { list: "pass", index: 0, kind: "request-review", skipped: true, reason: "Team other/x is not in acme." },
      { list: "pass", index: 1, kind: "request-review", skipped: true, reason: "No reviewer is left once the author is excluded." },
      { list: "pass", index: 2, effectId, kind: "assign", target: { users: ["octocat"] }, reason },
      { list: "pass", index: 3, kind: "assign", skipped: true, reason: "Assignees must be users and this target names none." },
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
    const ran = evaluateActions({ facts: author, checks: [], verdict: "pass", reason: "passes", pack });
    expect(ran.map((action) => ("skipped" in action ? action.reason : action.index))).toEqual([
      "Not run: the author is outside, not one of maintainers.",
      1,
      2,
      3,
      "Not run: membership of acme/ops is not known.",
    ]);
    const unknownKind = evaluateActions({ facts, checks: [], verdict: "pass", reason: "passes", pack });
    expect(unknownKind[0]).toMatchObject({ skipped: true, reason: "Not run: the author's kind is not known, so it cannot tell whether they are maintainers." });
  });

  test("derived labels name the verdict and each failed rule, and take back only their own that no longer apply", () => {
    const labelled = { ...facts, labels: ["api", "Triage: Needs changes", "triage: fail", "rule: docs", "rule: focused", "rule: deploy-freeze"] };
    function failed(check: string) {
      return { check, kind: "model" as const, result: "fail" as const, reason: "failed", evidence: [], output: { kind: "not-applicable" as const } };
    }
    const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), pass: [{ do: "labels", target: { from: "verdict" } }, { do: "labels", target: { from: "rules" } }] satisfies Step[] } };
    expect(targets(evaluateActions({ facts: labelled, checks: [failed("focused"), failed("no-changes-requested")], verdict: "pass", reason: "passes", pack }))).toEqual([
      { labels: ["triage: pass"], unlabel: ["Triage: Needs changes", "triage: fail"] },
      { labels: ["rule: focused"], unlabel: ["rule: docs"] },
    ]);
  });

  test("a merge is held with the real CI state until CI passes, and goes ahead without CI only when the policy switched CI green off", () => {
    function merge(ci: PrFacts["checks"], ciGreen?: boolean) {
      const pack = { ...emptyPack("acme/widgets"), checks: ciGreen === undefined ? {} : { "ci-green": { enabled: ciGreen } }, actions: { ...defaultActions(), pass: [{ do: "merge" }] satisfies Step[] } };
      return heldApprovals(evaluateActions({ facts: { ...facts, checks: ci }, checks: [], verdict: "pass", reason: "passes", pack }), undefined, ci)[0];
    }
    expect(merge("pending", false)).toMatchObject({ effectId: expect.any(String), held: true, reason: "CI has not finished on this head." });
    expect(merge("none", true)).toMatchObject({ held: true, reason: "There is no CI on this head." });
    expect(merge("none")).toMatchObject({ held: true, reason: "There is no CI on this head." });
    expect(merge("none", false)).toMatchObject({ target: { ciOptional: true }, reason: "passes" });
    expect(merge("none", false)).not.toHaveProperty("held");
    expect(merge("success", true)).not.toHaveProperty("held");
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
