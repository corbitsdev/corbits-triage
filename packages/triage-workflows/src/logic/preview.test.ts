import { expect, test } from "bun:test";
import { emptyPack, type Action, type CheckRef } from "@corbits/triage-contracts";
import type { ActionInput } from "./actions.js";
import type { PrFacts } from "./checks.js";
import { previewActions } from "./preview.js";
import { NEEDS_JUDGE_REASON } from "./render.js";

const facts: PrFacts = {
  repo: "acme/widgets", number: 8, title: "Add search", author: "octocat", tier: "external", headSha: "abc", state: "open", draft: false,
  mergeable: true, baseBehindBy: 0, checks: "success", requestedReviewers: 0, approvals: 0, openPrs: [], event: "opened",
};

const checks: ActionInput["checks"] = [
  { check: "ci", kind: "machine", result: "pass", reason: "", evidence: [] },
  { check: "size", kind: "machine", result: "fail", reason: "", evidence: [] },
  { check: "focused", kind: "model", result: "unconfirmed", reason: NEEDS_JUDGE_REASON, evidence: [] },
];

function branching(id: string, when: Action["when"], refs: CheckRef[]): Action {
  const say = (body: string) => [{ kind: "comment" as const, automatic: false, target: { body } }];
  return { id, when, checks: refs, branches: { yes: say("yes"), no: say("no"), unsure: say("unsure") } };
}

test("previewActions decides what the judge cannot change and lists the branches it can", () => {
  const actions = [
    branching("rule-only", ["opened"], ["ci"]),
    branching("judged", ["opened"], ["ci", "focused"]),
    branching("failing", ["opened"], ["size", "focused"]),
    branching("asleep", ["updated"], ["ci"]),
    branching("off", ["opened"], ["drift"]),
  ];
  const preview = previewActions({ facts, checks, pack: { ...emptyPack("acme/widgets"), actions }, roles: {} });
  expect(preview.map((p) => [p.id, p.status, "branch" in p ? p.branch : "branches" in p ? p.branches.map((b) => b.branch) : null])).toEqual([
    ["rule-only", "decided", "yes"],
    ["judged", "waits-on-judge", ["yes", "no", "unsure"]],
    ["failing", "decided", "no"],
    ["asleep", "not-woken", null],
    ["off", "skipped", null],
  ]);
  const judged = preview[1]!;
  if (judged.status !== "waits-on-judge") throw new Error("judged must wait on the judge");
  expect(judged.branches.map((b) => b.dos.map((d) => ("target" in d ? d.target : null)))).toEqual([[{ body: "yes" }], [{ body: "no" }], [{ body: "unsure" }]]);
  expect(preview[2]).toMatchObject({ reason: "Size failed.", dos: [{ effectId: expect.any(String), target: { body: "no" } }] });
});
