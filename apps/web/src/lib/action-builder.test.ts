import { describe, expect, test } from "bun:test";
import { CUSTOM_CHECK_CAP, recommendedPack, type CustomCheck, type Do } from "@corbits/triage-contracts";
import { actionFormOf, buildAction, buildCustomCheck, checkFormOf, type ActionEvent, type ActionForm, type CheckForm, type DoForm } from "./action-builder.ts";

const pack = recommendedPack("acme/widgets");
const comment: DoForm = { kind: "comment", automatic: true, body: "Thanks!", labels: ["stale"], prompt: "unused" };
const commented: Do = { kind: "comment", automatic: true, target: { body: "Thanks!" } };
const close: DoForm = { kind: "close", automatic: true };

function form(overrides: Partial<ActionForm>): ActionForm {
  return { when: "every", checks: [], yes: [], no: [], unsure: [], always: [], ...overrides };
}

const targets: Array<[DoForm, Do]> = [
  [{ kind: "labels", automatic: true, from: "list", labels: ["bug"], to: "users" }, { kind: "labels", automatic: true, target: { from: "list", labels: ["bug"] } }],
  [{ kind: "labels", automatic: true, from: "type", labels: ["bug"] }, { kind: "labels", automatic: true, target: { from: "type" } }],
  [comment, commented],
  [{ kind: "assign", automatic: true, to: "users", users: ["ada"], teams: ["core"] }, { kind: "assign", automatic: true, target: { to: "users", users: ["ada"] } }],
  [{ kind: "assign", automatic: true, to: "teams", teams: ["core"], role: "maintainers" }, { kind: "assign", automatic: true, target: { to: "teams", teams: ["core"] } }],
  [{ kind: "assign", automatic: true, to: "role", role: "maintainers", users: ["ada"] }, { kind: "assign", automatic: true, target: { to: "role", role: "maintainers" } }],
  [{ kind: "assign", automatic: true, to: "author", users: ["ada"] }, { kind: "assign", automatic: true, target: { to: "author" } }],
  [{ kind: "request-review", automatic: false, to: "codeowners", teams: ["core"] }, { kind: "request-review", automatic: false, target: { to: "codeowners" } }],
  [{ kind: "close", automatic: true, body: "unused" }, { kind: "close", automatic: true, target: {} }],
  [{ kind: "agent", automatic: true, prompt: "Fix CI", tools: ["git"], body: "unused" }, { kind: "agent", automatic: true, target: { prompt: "Fix CI", tools: ["git"] } }],
  [{ kind: "agent", automatic: false, prompt: "Fix CI" }, { kind: "agent", automatic: false, target: { prompt: "Fix CI", tools: [] } }],
];

describe("buildAction", () => {
  test("every Do target keeps exactly the contract keys", () => {
    const built = buildAction(form({ checks: ["ci"], yes: targets.map(([step]) => step) }), pack);
    expect(built).toEqual({ id: "action-1", when: "every", checks: ["ci"], branches: { yes: targets.map(([, expected]) => expected) } });
  });

  test("no checks gives always, ignoring branch lists", () => {
    const built = buildAction(form({ when: ["opened", "ready"], always: [comment], yes: [comment] }), pack);
    expect(built).toEqual({ id: "action-1", when: ["opened", "ready"], checks: [], branches: { always: [commented] } });
  });

  test("checks keep only the branches that have Dos, under the next free id", () => {
    const existing = { ...pack, actions: [{ id: "action-3", when: "every" as const, checks: [], branches: { always: [commented] } }] };
    const built = buildAction(form({ checks: ["ci", "size"], no: [close], unsure: [comment], always: [comment] }), existing);
    expect(built).toEqual({
      id: "action-4",
      when: "every",
      checks: ["ci", "size"],
      branches: { no: [{ kind: "close", automatic: true, target: {} }], unsure: [commented] },
    });
  });

  test("an edited action is rebuilt under its own id", () => {
    const first = { id: "action-1", when: ["opened" as const], checks: ["ci" as const], branches: { yes: [commented], unsure: [{ kind: "close" as const, automatic: false, target: {} }] } };
    const second = { id: "action-2", when: "every" as const, checks: [], branches: { always: [commented] } };
    const existing = { ...pack, actions: [first, second] };
    expect(buildAction(actionFormOf(first), existing, "action-1")).toEqual(first);
    expect(buildAction({ ...actionFormOf(first), checks: [], always: [comment] }, existing, "action-1")).toEqual({ id: "action-1", when: ["opened"], checks: [], branches: { always: [commented] } });
  });

  test("refusals carry the readCheckPack reason", () => {
    const agent: DoForm = { kind: "agent", automatic: true, prompt: "Fix CI" };
    expect(buildAction(form({ always: [close] }), pack)).toEqual({ reason: "Action action-1 branches always 1 cannot close automatically." });
    expect(buildAction(form({ always: [agent] }), pack)).toEqual({ reason: "Action action-1 branches always 1 cannot agent automatically." });
    expect(buildAction(form({ checks: ["ci"], unsure: [close] }), pack)).toEqual({ reason: "Action action-1 branches unsure 1 cannot close automatically." });
    expect(buildAction(form({}), pack)).toEqual({ reason: "Action action-1 branches always must not be empty." });
    expect(buildAction(form({ checks: ["ci"], always: [comment] }), pack)).toEqual({ reason: "Action action-1 branches must set at least one step." });
    expect(buildAction(form({ when: ["opened", "catch-up"] as ActionEvent[], always: [comment] }), pack)).toEqual({
      reason: "Action action-1 when must not list catch-up; catch-up runs every action.",
    });
  });
});

const checkForms: Array<[CheckForm, CustomCheck]> = [
  [{ name: "Lockfile", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"], claim: "unused" }, { id: "custom-1", name: "Lockfile", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["bun.lock"] }],
  [{ name: "Schema", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["db/**"], requires: ["migrations/**"] }, { id: "custom-1", name: "Schema", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["db/**"], requires: ["migrations/**"] }],
  [{ name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^feat" }, { id: "custom-1", name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^feat" }],
  [{ name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" }, { id: "custom-1", name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-" }],
  [{ name: "Label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" }, { id: "custom-1", name: "Label", group: "issue", kind: "rule", rule: "label-required", label: "triaged" }],
  [{ name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" }, { id: "custom-1", name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" }],
  [{ name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 }, { id: "custom-1", name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 }],
  [{ name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated", globs: ["x"] }, { id: "custom-1", name: "Changelog", group: "pull-request", kind: "model", shape: "is-true", claim: "The changelog is updated" }],
  [{ name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", min: 6 }, { id: "custom-1", name: "Clarity", group: "pull-request", kind: "model", shape: "score", subject: "Description clarity", min: 6 }],
  [{ name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }, { id: "custom-1", name: "Risk", group: "around", kind: "model", shape: "choose", options: ["low", "high"], failOn: ["high"] }],
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
    expect(full.custom.at(-1)!.id).toBe(`custom-${CUSTOM_CHECK_CAP}`);
    expect(buildCustomCheck(checkForms[0]![0], full)).toEqual({ reason: `Check pack must have at most ${CUSTOM_CHECK_CAP} custom checks.` });
  });
});
