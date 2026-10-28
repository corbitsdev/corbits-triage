import { describe, expect, test } from "bun:test";
import { AUTHOR_ASSOCIATIONS, authorKindOf, defaultActions, emptyPack, readCheckPack, readPolicyFile, whenHolds, type AuthorAssociation, type Step, type PolicyActions, type VerdictWord } from "@corbits/triage-contracts";
import { doEffectId, evaluateActions, heldApprovals, holdDos, type ActionInput, type SuggestedAction, type SuggestedDo } from "./actions.js";
import type { PrFacts } from "./checks.js";
import { NO_FACTS } from "./item.js";

const facts: PrFacts = {
  ...NO_FACTS,
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
      { ...say("maintainers"), when: { author: ["OWNER", "MEMBER", "COLLABORATOR"] } },
      { ...say("outside"), when: { author: ["NONE"] } },
      { ...say("team"), when: { author: [{ team: "acme/core" }] } },
      { ...say("named"), when: { author: [{ users: ["OctoCat"] }] } },
      { do: "nothing" },
      { ...say("unknown team"), when: { author: [{ team: "acme/ops" }] } },
    ] satisfies Step[] } };
    const author = { ...facts, authorKind: "NONE" as const, authorTeams: ["acme/core"], authorTeamsUnknown: ["acme/ops"] };
    const ran = evaluateActions({ facts: author, checks: [], verdict: "pass", reason: "passes", pack });
    expect(ran.map((action) => ("skipped" in action ? action.reason : action.index))).toEqual([
      "Not run: the author is NONE, not OWNER or MEMBER or COLLABORATOR.",
      1,
      2,
      3,
      "Not run: it is not known whether the author is acme/ops.",
    ]);
    const unknownKind = evaluateActions({ facts, checks: [], verdict: "pass", reason: "passes", pack });
    expect(unknownKind[0]).toMatchObject({ skipped: true, reason: "Not run: it is not known whether the author is OWNER or MEMBER or COLLABORATOR." });
  });

  test("a step runs only when its linked issue, CI and size conditions all hold", () => {
    const sized = { ...facts, body: "Fixes #12", checks: "failure" as const, changedFiles: 4, additions: 300, deletions: 20 };
    const pack = { ...emptyPack("acme/widgets"), actions: { ...defaultActions(), fail: [
      { ...say("linked"), when: { linkedIssue: true, ci: ["failing"], lines: { over: 300 } } },
      { ...say("unlinked"), when: { linkedIssue: false } },
      { ...say("green"), when: { ci: ["passing", "pending"] } },
      { ...say("small"), when: { files: { atMost: 3 } } },
    ] satisfies Step[] } };
    const ran = evaluateActions({ facts: sized, checks: [], verdict: "fail", reason: "fails", pack });
    expect(ran.map((action) => ("skipped" in action ? action.reason : action.index))).toEqual([
      0,
      "Not run: it links an issue.",
      "Not run: its CI is failing.",
      "Not run: it changes 4 files, not at most 3.",
    ]);
  });

  test("rule labels name each failed rule, and take back only their own that no longer apply", () => {
    const labelled = { ...facts, labels: ["api", "rule: docs", "rule: focused", "rule: deploy-freeze"] };
    function failed(check: string) {
      return { check, kind: "model" as const, result: "fail" as const, reason: "failed", evidence: [], output: { kind: "not-applicable" as const } };
    }
    const pack = {
      ...emptyPack("acme/widgets"),
      actions: { ...defaultActions(), pass: [{ do: "labels", target: { from: "rules" } }] } satisfies PolicyActions,
    };
    const checks = [failed("focused"), failed("no-changes-requested")];
    expect(targets(evaluateActions({ facts: labelled, checks, verdict: "pass", reason: "passes", pack }))).toEqual([
      { labels: ["rule: focused"], unlabel: ["rule: docs"] },
    ]);
  });

  test("a merge is held with the real CI state until CI passes, and goes ahead without CI only when the policy switched CI green off", () => {
    function merge(ci: PrFacts["checks"], ciGreen?: boolean) {
      const pack = { ...emptyPack("acme/widgets"), checks: ciGreen === undefined ? {} : { "ci-green": { enabled: ciGreen } }, actions: { ...defaultActions(), pass: [{ do: "merge" }] satisfies Step[] } };
      return heldApprovals(evaluateActions({ facts: { ...facts, checks: ci }, checks: [], verdict: "pass", reason: "passes", pack }), undefined, ci)[0];
    }
    expect(merge("pending", false)).toMatchObject({ effectId: expect.any(String), held: true, heldUntil: "ci-finishes", reason: "CI has not finished on this head.", ci: "pending" });
    expect(merge("none", true)).toMatchObject({ held: true, reason: "There is no CI on this head.", ci: "none" });
    expect(merge("none", true)).not.toHaveProperty("heldUntil");
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

describe("author groups written before author kinds were GitHub's", () => {
  // How a group matched before: the association folded to a kind, and the group's kinds.
  const OLD_KIND: Record<AuthorAssociation, string> = {
    OWNER: "owner", MEMBER: "member", COLLABORATOR: "collaborator", CONTRIBUTOR: "contributor",
    FIRST_TIME_CONTRIBUTOR: "first-timer", FIRST_TIMER: "first-timer", NONE: "outside", MANNEQUIN: "outside",
  };
  const OLD_GROUP: Record<string, string[]> = {
    "first-timers": ["first-timer"], maintainers: ["owner", "member", "collaborator"], external: ["contributor", "first-timer", "outside"], bots: ["bot"],
  };
  const AUTHORS: Array<[AuthorAssociation | null, boolean]> = [...AUTHOR_ASSOCIATIONS.map((a): [AuthorAssociation, boolean] => [a, false]), ["NONE", true], [null, false]];
  const subject = { linkedIssue: false, ci: "passing", files: 1, lines: 1 } as const;

  function oldMatch(group: string, association: AuthorAssociation | null, bot: boolean): boolean | undefined {
    if (bot) return OLD_GROUP[group]!.includes("bot");
    return association === null ? undefined : OLD_GROUP[group]!.includes(OLD_KIND[association]);
  }

  test.each(Object.keys(OLD_GROUP))("%s, as when.author or for, matches exactly the authors it matched before", (group) => {
    const pass = [{ do: "approve", when: { author: [group] } }, { do: "merge", for: group }];
    const { actions } = readCheckPack({ ...emptyPack("acme/widgets"), actions: { when: ["opened"], pass, fail: [], unsure: [] } });
    for (const [association, bot] of AUTHORS) {
      const author = { login: "octocat", kind: authorKindOf(association, bot) };
      const matches = actions.pass.map((step) => whenHolds(step.when, { ...subject, author }).matches);
      expect({ association, bot, matches }).toEqual({ association, bot, matches: [oldMatch(group, association, bot), oldMatch(group, association, bot)] });
    }
  });

  test("a policy naming groups keeps every step in its place, so the effect ids its steps run under are unchanged", () => {
    const pass = [
      { do: "approve", for: "maintainers" },
      { do: "labels", target: { from: "list", labels: ["new"] }, when: { author: ["external", "first-timers"] } },
      { do: "labels", target: { from: "list", labels: ["new"] }, when: { author: ["external"] } },
      { do: "comment", target: { body: "Welcome" }, when: { author: ["first-timers"] } },
      { do: "close", for: "bots" },
    ];
    const pack = readCheckPack({ ...emptyPack("acme/widgets"), actions: { when: ["opened"], pass, fail: [], unsure: [] } });
    expect(pack.actions.pass.map(({ when: _when, ...step }) => step)).toEqual(pass.map(({ for: _for, when: _when, ...step }) => step));
    const ran = evaluateActions({ facts: { ...facts, labels: [], authorKind: "FIRST_TIME_CONTRIBUTOR" }, checks: [], verdict: "pass", reason: "passes", pack });
    expect(ran.flatMap((a) => ("skipped" in a ? [] : [[a.index, a.kind]]))).toEqual([[1, "labels"], [2, "labels"], [3, "comment"]]);
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

  test("only a Do the role may write keeps waiting for CI to finish; one held for a person does not", () => {
    const label: SuggestedDo = { list: "fail", index: 0, kind: "labels", reason: "", effectId: "e-label", target: { labels: ["bug"] } };
    const [granted] = holdDos(heldApprovals([label], undefined, "pending"), ["labels"]);
    const [asked] = holdDos(heldApprovals([label], undefined, "pending"), []);
    expect(granted).toMatchObject({ held: true, heldUntil: "ci-finishes" });
    expect(asked).toMatchObject({ held: true });
    expect(asked).not.toHaveProperty("heldUntil");
  });
});

describe("a step for a group the policy file defines", () => {
  const file = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required.
    evidence: [maintainer-stated]
groups:
  interns: { teams: [acme/interns] }
  staff: { association: [MEMBER] }
actions:
  pass: [{ do: approve, when: { author: [staff] } }]
`;
  const pack = readCheckPack(readPolicyFile(file, "acme/widgets"), "acme/widgets");
  const member = { ...facts, authorKind: "MEMBER" as const };

  test("goes by the first group the author matches, its teams read", () => {
    expect(evaluateActions({ facts: { ...member, authorTeams: ["acme/interns"], authorTeamsUnknown: [] }, checks: [], verdict: "pass", reason: "passes", pack })).toEqual([
      { list: "pass", index: 0, kind: "approve", skipped: true, reason: "Not run: the author is MEMBER, not staff." },
    ]);
    expect(evaluateActions({ facts: { ...member, authorTeams: [], authorTeamsUnknown: [] }, checks: [], verdict: "pass", reason: "passes", pack })).toMatchObject([{ kind: "approve", effectId: expect.any(String) }]);
  });

  test("does not run while teams that would decide the author's group can't be read", () => {
    expect(evaluateActions({ facts: { ...member, authorTeams: [], authorTeamsUnknown: ["acme/interns"] }, checks: [], verdict: "pass", reason: "passes", pack })).toEqual([
      { list: "pass", index: 0, kind: "approve", skipped: true, reason: "Not run: it is not known whether the author is staff." },
    ]);
  });
});
