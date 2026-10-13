import { expect, test } from "bun:test";
import type { PreviewActions, PullPreview } from "./hub-api.ts";
import { previewProse } from "./preview-prose.ts";

const base = { index: 0, effectId: "e", reason: "No vendor changes failed." };

function preview(verdict: "fail" | "unsure", reason: string, actions: PreviewActions): PullPreview {
  return {
    repo: "acme/widgets",
    number: 12,
    headSha: "abc1234def",
    event: "catch-up",
    pack: "candidate",
    judge: "not-run",
    verdict: { state: "needs-author-update", priority: "p2", labels: [], owner: "", humanGated: false, verdict, score: null, reasons: verdict === "fail" ? ["No vendor changes: vendor/a.ts"] : [], degraded: null, reason, nextAction: "", actor: "author", feedback: "Thanks!\n\nPlease add tests." },
    checks: [
      { check: "max-files-changed", name: "Max files changed", kind: "machine", result: "pass", reason: "", evidence: [], output: { kind: "values", values: { files: 33 } } },
      { check: "custom-1", name: "No vendor changes", kind: "machine", result: "fail", reason: "", evidence: [], output: { kind: "values", values: { holds: false } } },
      { check: "custom-2", name: "Clear intent", kind: "model", result: "needs-judge", reason: "needs the judge", evidence: [], output: { kind: "could-not-check", reason: "needs the judge" } },
    ],
    actions,
  };
}

test.each<[string, PullPreview, Pick<ReturnType<typeof previewProse>, "verdict" | "lists" | "notWoken">]>([
  [
    "a decided verdict runs its list",
    preview("fail", "No vendor changes failed", { status: "decided", verdict: "fail", dos: [
      { ...base, list: "fail", kind: "comment", target: { body: "Please leave vendor/ alone." } },
      { ...base, list: "fail", index: 1, kind: "request-review", target: { users: ["ada"], teams: ["core"] } },
    ] }),
    { verdict: "Fail: No vendor changes: vendor/a.ts.", lists: [{ list: "On Fail", dos: "comment “Please leave vendor/ alone.”, then request review from @ada and @acme/core." }], notWoken: null },
  ],
  [
    "a verdict waiting on the judge shows every list",
    preview("unsure", "needs the judge", { status: "waits-on-judge", lists: [
      { verdict: "pass", dos: [{ ...base, list: "pass", kind: "labels", target: { labels: ["ready"] } }] },
      { verdict: "fail", dos: [] },
      { verdict: "unsure", dos: [{ list: "unsure", index: 0, kind: "assign", reason: "Assignees must be users and this target names none.", skipped: true }] },
    ] }),
    { verdict: "The verdict waits on the judge.", lists: [
      { list: "On Pass", dos: "add the label ready." },
      { list: "On Fail", dos: "nothing to do." },
      { list: "On Unsure", dos: "skip assign (Assignees must be users and this target names none)." },
    ], notWoken: null },
  ],
  [
    "an event the policy does not name runs nothing",
    preview("unsure", "needs the judge", { status: "not-woken" }),
    { verdict: "Unsure: needs the judge.", lists: [], notWoken: "This event does not wake the policy's actions." },
  ],
])("%s", (_, previewed, want) => {
  const prose = previewProse(previewed);
  expect({ verdict: prose.verdict, lists: prose.lists, notWoken: prose.notWoken }).toEqual(want);
  expect(prose.checks).toEqual([
    { result: "pass", label: "Passed", names: ["Max files changed (33 files)"] },
    { result: "fail", label: "Failed", names: ["No vendor changes (does not hold)"] },
    { result: "needs-judge", label: "Needs the judge", names: ["Clear intent"] },
  ]);
  expect(prose.comment).toBe("Thanks!\n\nPlease add tests.");
});
