import { expect, test } from "bun:test";
import { checkPolicyFile, policyFileReason } from "./policy-file.ts";
import { patchPolicyFile, type PolicyPatchChange } from "./policy-patch.ts";

const REPO = "acme/widgets";

const FILE = `# Corbits Triage policy.
rules:
  # leave ci-green alone
  - check: ci-green
    text: CI passes.
    reason: Required by branch protection.
    evidence: [maintainer-stated]
  - check: focused
    text: One focused change.
    reason: Mixed changes were split.
    evidence: [maintainer-stated]
  - check: max-lines-changed
    text: Flag pull requests over 400 lines changed.
    reason: Review load.
    evidence: [maintainer-stated]
    max: 400
pauseLabel: hold
`;

const CHANGES: PolicyPatchChange[] = [
  { kind: "rule", id: "focused", enabled: false },
  { kind: "rule-options", id: "max-lines-changed", options: { max: 200 } },
  { kind: "rule", id: "docs", enabled: true },
  { kind: "rule-options", id: "docs", options: { reason: "Docs drift from the code." } },
  { kind: "code-review", on: true },
];

test("a comment above an untouched rule survives a change to another rule", () => {
  const patched = patchPolicyFile(FILE, REPO, CHANGES);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text.startsWith(FILE.slice(0, FILE.indexOf("  - check: focused")))).toBe(true);
  const commentAt = patched.text.indexOf("# leave ci-green alone");
  const ciAt = patched.text.indexOf("check: ci-green");
  expect(commentAt).toBeGreaterThanOrEqual(0);
  expect(commentAt).toBeLessThan(ciAt);
  expect(patched.text).toContain("text: CI passes.");
  expect(patched.text).toContain("pauseLabel: hold");
  expect(patched.text).toContain("text: Flag pull requests over 200 lines changed.");
  expect(patched.text).not.toContain("over 400");
  expect(patched.text).toContain("max: 200");
  expect(patched.text).toContain("Check docs are updated when behavior changes.");
  expect(patched.text).toContain("enabled: false");
  const focusedAt = patched.text.indexOf("check: focused");
  const nextAt = patched.text.indexOf("check:", focusedAt + 1);
  expect(patched.text.slice(focusedAt, nextAt)).toContain("enabled: false");
  expect(patched.text.slice(ciAt, focusedAt)).not.toContain("enabled:");
  expect(checkPolicyFile(patched.text, REPO)).toMatchObject({ ok: true });
});

test("a batch that cannot be applied names the problem and writes no file", () => {
  const older = "checks:\n  ci-green: { enabled: true }\n";
  expect(patchPolicyFile(older, REPO, [{ kind: "rule", id: "ci-green", enabled: false }])).toEqual({
    ok: false,
    message: "This file has no rules list. It is the older policy shape and needs converting before it can be changed.",
  });
  expect(patchPolicyFile(FILE, REPO, [{ kind: "rule", id: "made-up", enabled: true }])).toEqual({
    ok: false,
    message: "Unknown rule made-up.",
  });
  expect(patchPolicyFile(FILE, REPO, [{ kind: "remove-rule", id: "docs" }])).toEqual({
    ok: false,
    message: "Rule docs is not in the file.",
  });
  for (const options of [{ check: "focused" }, { id: "focused" }]) {
    expect(patchPolicyFile(FILE, REPO, [{ kind: "rule-options", id: "ci-green", options }])).toEqual({
      ok: false,
      message: "Rule ci-green's check and id cannot be changed.",
    });
  }
  const rule = { id: "errors-are-handled", check: "model" as const, text: "Errors are handled.", reason: "Outages.", evidence: ["maintainer-stated"] };
  const added = patchPolicyFile(FILE, REPO, [{ kind: "add-rule", rule }]);
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(patchPolicyFile(added.text, REPO, [{ kind: "add-rule", rule }])).toEqual({
    ok: false,
    message: "Rule errors-are-handled is already in the file.",
  });
});

const BASE = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required by branch protection.
    evidence: [maintainer-stated]
`;

test("options later in the batch apply to a built-in rule turned on earlier", () => {
  const patched = patchPolicyFile(BASE, REPO, [
    { kind: "rule", id: "docs", enabled: true },
    { kind: "rule-options", id: "docs", options: { onFail: "label", label: "needs-docs", reason: "Docs drift from the code." } },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text).toContain("check: docs");
  expect(patched.text).toContain("onFail: label");
  expect(patched.text).toContain("label: needs-docs");
  expect(checkPolicyFile(patched.text, REPO)).toMatchObject({ ok: true });
});

test("a later change sees a custom rule added earlier in the batch", () => {
  const patched = patchPolicyFile(BASE, REPO, [
    { kind: "add-rule", rule: { id: "errors-are-handled", check: "model", text: "Errors are handled.", reason: "Outages.", evidence: ["maintainer-stated"] } },
    { kind: "rule", id: "errors-are-handled", enabled: false },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text).toContain("id: errors-are-handled");
  expect(patched.text).toContain("enabled: false");
  expect(checkPolicyFile(patched.text, REPO)).toMatchObject({ ok: true });
});

test("a limit set later in the batch lands on a size rule turned on earlier", () => {
  const patched = patchPolicyFile(BASE, REPO, [
    { kind: "rule", id: "max-lines-changed", enabled: true },
    { kind: "rule-options", id: "max-lines-changed", options: { max: 200, reason: "Review load." } },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text).toContain("check: max-lines-changed");
  expect(patched.text).toContain("text: Flag pull requests over 200 lines changed.");
  expect(patched.text).toContain("max: 200");
  expect(checkPolicyFile(patched.text, REPO)).toMatchObject({ ok: true });
});

test("turning on a catalog rule without a required field or a reason names the rule and the field", () => {
  expect(patchPolicyFile(BASE, REPO, [{ kind: "rule", id: "max-lines-changed", enabled: true }])).toEqual({
    ok: false,
    message: "Rule max-lines-changed is missing max.",
  });
  expect(patchPolicyFile(BASE, REPO, [{ kind: "rule", id: "no-forbidden-paths", enabled: true }])).toEqual({
    ok: false,
    message: "Rule no-forbidden-paths is missing paths.",
  });
  expect(patchPolicyFile(BASE, REPO, [{ kind: "rule", id: "docs", enabled: true }])).toEqual({
    ok: false,
    message: "Rule docs is missing reason.",
  });
});

test("an untouched rule is not held to what the batch must set; the file's own check judges it", () => {
  const incomplete = `${BASE}  - check: focused
    text: One focused change.
    evidence: [maintainer-stated]
`;
  const fileCheck = checkPolicyFile(incomplete, REPO);
  expect(fileCheck.ok).toBe(false);
  if (fileCheck.ok) return;
  expect(patchPolicyFile(incomplete, REPO, [{ kind: "code-review", on: true }])).toEqual({ ok: false, message: policyFileReason(fileCheck.problems) });
});

test("turning a disabled rule back on keeps its own text", () => {
  const disabled = `${BASE}  - check: max-lines-changed
    text: Keep it small.
    reason: Review load.
    evidence: [maintainer-stated]
    enabled: false
    max: 200
`;
  const patched = patchPolicyFile(disabled, REPO, [{ kind: "rule", id: "max-lines-changed", enabled: true }]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text).toContain("text: Keep it small.");
  expect(patched.text).toContain("enabled: true");
});

test("turning a rule on through its options does what turning it on does", () => {
  const stale = `${BASE}  - check: max-lines-changed
    text: Flag pull requests over 400 lines changed.
    reason: Review load.
    evidence: [maintainer-stated]
    enabled: false
    max: 200
`;
  const viaOptions = patchPolicyFile(stale, REPO, [{ kind: "rule-options", id: "max-lines-changed", options: { enabled: true } }]);
  expect(viaOptions).toEqual(patchPolicyFile(stale, REPO, [{ kind: "rule", id: "max-lines-changed", enabled: true }]));
  expect(viaOptions).toMatchObject({ ok: true, changed: true });
  const added = patchPolicyFile(BASE, REPO, [{ kind: "rule-options", id: "docs", options: { enabled: true, reason: "Docs drift from the code." } }]);
  expect(added).toEqual(patchPolicyFile(BASE, REPO, [
    { kind: "rule", id: "docs", enabled: true },
    { kind: "rule-options", id: "docs", options: { reason: "Docs drift from the code." } },
  ]));
  expect(added).toMatchObject({ ok: true, text: expect.stringContaining("check: docs") });
});

test("turning on a rule that is already on changes nothing", () => {
  expect(patchPolicyFile(BASE, REPO, [{ kind: "rule", id: "ci-green", enabled: true }])).toEqual({ ok: true, text: BASE, changed: false });
});

test("a rule's own text set in the batch outlasts a later limit or turn-on for it", () => {
  const disabled = `${BASE}  - check: max-lines-changed
    text: Keep it small.
    reason: Review load.
    evidence: [maintainer-stated]
    enabled: false
    max: 400
`;
  const patched = patchPolicyFile(disabled, REPO, [
    { kind: "rule-options", id: "max-lines-changed", options: { text: "Keep pull requests short." } },
    { kind: "rule-options", id: "max-lines-changed", options: { max: 200 } },
    { kind: "rule", id: "max-lines-changed", enabled: true },
  ]);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  expect(patched.text).toContain("text: Keep pull requests short.");
  expect(patched.text).toContain("max: 200");
});

test("a batch that changes nothing reads as unchanged even when the YAML library re-spaces the file", () => {
  const unindented = `rules:
- check: max-lines-changed
  text: "Flag pull requests over 400 lines changed."
  reason: Review load.
  evidence: [ maintainer-stated ]
  max: 400
`;
  const same = patchPolicyFile(unindented, REPO, [{ kind: "rule-options", id: "max-lines-changed", options: { max: 400 } }]);
  expect(same).toMatchObject({ ok: true, changed: false });
  if (!same.ok) return;
  expect(same.text).not.toBe(unindented);
  expect(patchPolicyFile(unindented, REPO, [{ kind: "rule-options", id: "max-lines-changed", options: { max: 300 } }])).toMatchObject({ ok: true, changed: true });
});

test("a built-in rule added whole gets its sentence from its limit", () => {
  const rule = { check: "max-lines-changed" as const, text: "Flag pull requests over 400 lines changed.", reason: "Review load.", evidence: ["maintainer-stated"], max: 200 };
  const patched = patchPolicyFile(BASE, REPO, [{ kind: "add-rule", rule }]);
  expect(patched).toMatchObject({ ok: true, changed: true });
  if (!patched.ok) return;
  expect(patched.text).toContain("text: Flag pull requests over 200 lines changed.");
  expect(patched.text).not.toContain("over 400");
});
