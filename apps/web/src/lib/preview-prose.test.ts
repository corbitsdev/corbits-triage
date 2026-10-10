import { expect, test } from "bun:test";
import { recommendedPack, type CheckPack } from "@corbits/triage-contracts";
import type { PreviewAction, PullPreview } from "./hub-api.ts";
import { previewProse } from "./preview-prose.ts";

const close = [{ kind: "close" as const, automatic: false, target: {} }];
const pack: CheckPack = {
  ...recommendedPack("acme/widgets"),
  actions: ["action-1", "action-2", "action-3", "action-4"].map((id) => ({ id, when: "every" as const, checks: [], branches: { always: close } })),
};

const base = { id: "action-1", index: 0, automatic: false, effectId: "e" };

function preview(actions: PreviewAction[]): PullPreview {
  return {
    repo: "acme/widgets",
    number: 12,
    headSha: "abc1234def",
    event: "catch-up",
    pack: "candidate",
    judge: "not-run",
    verdict: { state: "needs-human", priority: "p2", labels: [], owner: "", humanGated: true, confidence: "unknown", degraded: null, reason: "needs the judge", nextAction: "", actor: "maintainer", feedback: "Thanks!\n\nPlease add tests." },
    checks: [
      { check: "size", name: "Size", kind: "machine", result: "pass", reason: "", evidence: [] },
      { check: "custom-1", name: "No vendor changes", kind: "machine", result: "fail", reason: "", evidence: [] },
      { check: "custom-2", name: "Clear intent", kind: "model", result: "needs-judge", reason: "needs the judge", evidence: [] },
    ],
    actions,
  };
}

test.each<[string, PreviewAction[], Pick<ReturnType<typeof previewProse>, "actions" | "notWoken">]>([
  [
    "decided",
    [{ id: "action-1", status: "decided", branch: "no", reason: "No vendor changes failed.", dos: [
      { ...base, branch: "no", kind: "comment", reason: "No vendor changes failed.", target: { body: "Please leave vendor/ alone." } },
      { ...base, branch: "no", index: 1, kind: "request-review", automatic: true, reason: "No vendor changes failed.", target: { users: ["ada"], teams: ["core"] } },
    ] }],
    { actions: [{ id: "action-1", label: "Action 1", status: "decided", branch: { branch: "No", reason: "No vendor changes failed.", dos: "comment “Please leave vendor/ alone.”, then request review from @ada and @acme/core automatically." } }], notWoken: null },
  ],
  [
    "waits-on-judge",
    [{ id: "action-2", status: "waits-on-judge", branches: [
      { branch: "yes", reason: "Clear intent passed.", dos: [{ ...base, id: "action-2", branch: "yes", kind: "labels", reason: "Clear intent passed.", target: { labels: ["ready"] } }] },
      { branch: "no", reason: "Clear intent failed.", dos: [] },
      { branch: "unsure", reason: "Clear intent not confirmed.", dos: [{ id: "action-2", branch: "unsure", index: 0, kind: "assign", automatic: false, reason: "Assignees must be users and this target names none.", skipped: true }] },
    ] }],
    { actions: [{ id: "action-2", label: "Action 2", status: "waits-on-judge", branches: [
      { branch: "Yes", reason: "Clear intent passed.", dos: "add the label ready." },
      { branch: "No", reason: "Clear intent failed.", dos: "nothing to do." },
      { branch: "Unsure", reason: "Clear intent not confirmed.", dos: "skip assign (Assignees must be users and this target names none)." },
    ] }], notWoken: null },
  ],
  [
    "not-woken",
    [{ id: "action-3", status: "not-woken" }, { id: "action-4", status: "not-woken" }],
    { actions: [], notWoken: "Action 3 and Action 4 do not run on this event." },
  ],
  [
    "skipped",
    [{ id: "action-4", status: "skipped", reason: "Size is off in this pack." }],
    { actions: [{ id: "action-4", label: "Action 4", status: "skipped", reason: "Size is off in this pack." }], notWoken: null },
  ],
])("%s actions read as the panel's prose", (_, actions, want) => {
  const prose = previewProse(preview(actions), pack);
  expect({ actions: prose.actions, notWoken: prose.notWoken }).toEqual(want);
  expect(prose.checks).toEqual([
    { result: "pass", label: "Passed", names: ["Size"] },
    { result: "fail", label: "Failed", names: ["No vendor changes"] },
    { result: "needs-judge", label: "Needs the judge", names: ["Clear intent"] },
  ]);
  expect(prose.comment).toBe("Thanks!\n\nPlease add tests.");
  expect(prose.degraded).toBeNull();
});
