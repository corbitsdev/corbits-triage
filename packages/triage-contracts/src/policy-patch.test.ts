import { expect, test } from "bun:test";
import { checkPolicyFile } from "./policy-file.ts";
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
  { kind: "code-review", on: true },
];

test("a comment above an untouched rule survives a change to another rule", () => {
  const patched = patchPolicyFile(FILE, REPO, CHANGES);
  expect(patched.ok).toBe(true);
  if (!patched.ok) return;
  const commentAt = patched.text.indexOf("# leave ci-green alone");
  const ciAt = patched.text.indexOf("check: ci-green");
  expect(commentAt).toBeGreaterThanOrEqual(0);
  expect(commentAt).toBeLessThan(ciAt);
  expect(patched.text).toContain("text: CI passes.");
  expect(patched.text).toContain("pauseLabel: hold");
  expect(patched.text).toContain("text: Flag pull requests over 400 lines changed.");
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
  const rule = { id: "errors-are-handled", check: "model" as const, text: "Errors are handled.", reason: "Outages.", evidence: ["maintainer-stated"] };
  const added = patchPolicyFile(FILE, REPO, [{ kind: "add-rule", rule }]);
  expect(added.ok).toBe(true);
  if (!added.ok) return;
  expect(patchPolicyFile(added.text, REPO, [{ kind: "add-rule", rule }])).toEqual({
    ok: false,
    message: "Rule errors-are-handled is already in the file.",
  });
});
