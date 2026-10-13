import { describe, expect, test } from "bun:test";
import { CUSTOM_CHECK_CAP, recommendedPack, type CustomCheck, type Step } from "@corbits/triage-contracts";
import { buildCustomCheck, buildDo, checkFormOf, doFormOf, type CheckForm, type DoForm } from "./action-builder.ts";

const pack = recommendedPack("acme/widgets");
const comment: DoForm = { kind: "comment", body: "Thanks!", labels: ["stale"] };
const commented: Step = { do: "comment", target: { body: "Thanks!" } };

const targets: Array<[DoForm, Step]> = [
  [{ kind: "labels", from: "list", labels: ["bug"], to: "users" }, { do: "labels", target: { from: "list", labels: ["bug"] } }],
  [{ kind: "labels", from: "verdict", labels: ["bug"] }, { do: "labels", target: { from: "verdict" } }],
  [comment, commented],
  [{ kind: "assign", to: "users", users: ["ada"], teams: ["core"] }, { do: "assign", target: { to: "users", users: ["ada"] } }],
  [{ kind: "assign", to: "teams", teams: ["core"], role: "maintainers" }, { do: "assign", target: { to: "teams", teams: ["core"] } }],
  [{ kind: "assign", to: "role", role: "maintainers", users: ["ada"] }, { do: "assign", target: { to: "role", role: "maintainers" } }],
  [{ kind: "assign", to: "author", users: ["ada"] }, { do: "assign", target: { to: "author" } }],
  [{ kind: "request-review", to: "codeowners", teams: ["core"], for: "first-timers" }, { do: "request-review", target: { to: "codeowners" }, for: "first-timers" }],
  [{ kind: "close", body: "unused" }, { do: "close" }],
  [{ kind: "merge", for: { team: "acme/core" } }, { do: "merge", for: { team: "acme/core" } }],
];

describe("buildDo", () => {
  test("every step target keeps exactly the contract keys, and a stored step edits back to itself", () => {
    for (const [step, expected] of targets) {
      expect(buildDo(step)).toEqual(expected);
      expect(buildDo(doFormOf(expected))).toEqual(expected);
    }
  });
});

const checkForms: Array<[CheckForm, CustomCheck]> = [
  [{ name: "Lockfile", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"], claim: "unused" }, { id: "lockfile", name: "Lockfile", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"] }],
  [{ name: "Schema", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["db/**"], requires: ["migrations/**"] }, { id: "schema", name: "Schema", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["db/**"], requires: ["migrations/**"] }],
  [{ name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^feat" }, { id: "title", name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^feat" }],
  [{ name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" }, { id: "branch", name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" }],
  [{ name: "Label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" }, { id: "label", name: "Label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" }],
  [{ name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" }, { id: "no-debug", name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" }],
  [{ name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 }, { id: "approved", name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 }],
  [{ name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated", globs: ["x"] }, { id: "changelog", name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated" }],
  [{ name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back", scope: "hunk", when: ["migrations/**"] }, { id: "reversible", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back", scope: "hunk", when: ["migrations/**"] }],
  [{ name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", levels: ["poor", "good"], failBelow: "good" }, { id: "clarity", name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", levels: ["poor", "good"], failBelow: "good" }],
  [{ name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }, { id: "risk", name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }],
];

describe("buildCustomCheck", () => {
  test("every rule and shape keeps only its parameters", () => {
    for (const [check, expected] of checkForms) expect(buildCustomCheck(check, pack)).toEqual(expected);
  });

  test("an edited check keeps its id and place", () => {
    const existing = { ...pack, custom: checkForms.slice(0, 2).map(([, check], i) => ({ ...check, id: `custom-${i + 1}` }) as CustomCheck) };
    const [, edited] = checkForms[2]!;
    expect(buildCustomCheck(checkFormOf({ ...edited, id: "custom-1" }), existing, "custom-1")).toEqual({ ...edited, id: "custom-1" });
  });

  test("the ninth check is refused with the readCheckPack reason", () => {
    let full = pack;
    for (let i = 0; i < CUSTOM_CHECK_CAP; i++) {
      const built = buildCustomCheck(checkForms[0]![0], full);
      if ("reason" in built) throw new Error(built.reason);
      full = { ...full, custom: [...full.custom, built] };
    }
    expect(full.custom.at(-1)!.id).toBe(`lockfile-${CUSTOM_CHECK_CAP}`);
    expect(buildCustomCheck(checkForms[0]![0], full)).toEqual({ reason: `Policy must have at most ${CUSTOM_CHECK_CAP} custom rules.` });
  });
});
