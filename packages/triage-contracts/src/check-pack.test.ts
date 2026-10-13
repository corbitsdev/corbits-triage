import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import {
  applyRecommended,
  catalogCheckEnabled,
  checkPackSchema,
  customRuleId,
  defaultActions,
  emptyPack,
  parseCheckPack,
  readCheckPack,
  recommendedPack,
  type CheckPack,
  type CustomCheck,
  type PolicyActions,
} from "./check-pack.ts";

const REPO = "acme/payments-api";

function customRow(i: number) {
  return {
    id: `custom-${i + 1}`,
    name: i === 2 ? "  " : `Check ${i + 1}`,
    group: i === 3 ? "not-a-group" : "pull-request",
    instruction: i === 4 ? "" : `Do the thing ${i + 1}`,
  };
}

const CUSTOM: CustomCheck[] = [{ id: "custom-1", name: "Ticket", group: "pull-request", kind: "model", shape: "is-true", claim: "Mention a ticket." }];
const RULES: CustomCheck[] = [
  { id: "custom-1", name: "Vendor", group: "code-vs-ci", kind: "rule", rule: "paths-unchanged", globs: ["vendor/**"] },
  { id: "custom-2", name: "Schema", group: "code-vs-ci", kind: "rule", rule: "paths-together", changed: ["db/schema.ts"], requires: ["db/migrations/**"] },
  { id: "custom-3", name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^(feat|fix)(\\(.+\\))?: .+" },
  { id: "custom-4", name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-\\d+" },
  { id: "custom-5", name: "Labelled", group: "issue", kind: "rule", rule: "label-required", label: "triaged" },
  { id: "custom-6", name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" },
  { id: "custom-7", name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 },
];
const AUTHORS: CustomCheck[] = [
  { id: "custom-1", name: "Mine", group: "pull-request", kind: "rule", rule: "author", who: "users", users: ["maya"] },
  { id: "custom-2", name: "Core", group: "pull-request", kind: "rule", rule: "author", who: "role", role: "maintainers" },
  { id: "custom-3", name: "Agents", group: "pull-request", kind: "rule", rule: "author", who: "kinds", kinds: ["bot", "first-timer"] },
];
const MODELS: CustomCheck[] = [
  ...CUSTOM,
  { id: "custom-2", name: "Risk", group: "pull-request", kind: "model", shape: "score", subject: "safety", min: 6 },
  { id: "custom-3", name: "Size", group: "pull-request", kind: "model", shape: "choose", options: ["small", "large"], failOn: ["large"] },
  { id: "custom-4", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back.", scope: "file", when: ["migrations/**"] },
];
const COMMENT = { kind: "comment", target: { body: "Thanks!" } } as const;
const REVIEW = { kind: "request-review", target: { to: "role", role: "maintainers" } } as const;
const ACTIONS: PolicyActions = {
  when: ["opened", "ready"],
  pass: [REVIEW],
  fail: [COMMENT, { kind: "request-changes", target: {} }],
  unsure: [{ kind: "labels", target: { from: "list", labels: ["needs-triage"] } }],
};

describe("check pack contract", () => {
  test("add one catalog check; unknown ids ignored; absent keys empty", () => {
    const parsed = parseCheckPack({
      kind: "corbits.triage.check-pack",
      schemaVersion: 1,
      repo: REPO,
      checks: {
        "no-merge-conflicts": { enabled: true },
        notACheck: { enabled: true },
        "max-files-changed": { enabled: false, maxFiles: 10, maxLines: 100 },
      },
    });
    expect(parsed?.checks).toEqual({
      "no-merge-conflicts": { enabled: true },
      "max-files-changed": { enabled: false, maxFiles: 10 },
    });
    expect(parsed?.custom).toEqual([]);
    expect(catalogCheckEnabled(parsed!, "no-merge-conflicts")).toBe(true);
    expect(catalogCheckEnabled(parsed!, "max-files-changed")).toBe(false);
    expect(catalogCheckEnabled(parsed!, "ci-green")).toBe(false);
  });

  test("a stored pack naming removed checks loads without them", () => {
    const read = readCheckPack({
      ...emptyPack(REPO),
      checks: {
        draft: { enabled: true },
        duplicate: { enabled: true },
        reviewers: { enabled: true },
        drift: { enabled: true, maxBehindBy: 50 },
        tests: { enabled: true },
        "linked-issue": { enabled: true, tracker: "github", requireLabel: true, label: "linked" },
      },
    });
    expect(read.checks).toEqual({ "linked-issue": { enabled: true, tracker: "github" } });
  });

  test("a stored policy with the old rule ids reads as the rules that replaced them; a row under its new id wins", () => {
    const read = readCheckPack({
      ...emptyPack(REPO),
      checks: {
        size: { enabled: true, maxFiles: 20, maxLines: 500 },
        issue: { enabled: true, tracker: "linear" },
        conflicts: { enabled: false },
        ci: { enabled: true },
        "ci-green": { enabled: false },
        paths: { enabled: true, forbiddenGlobs: ["vendor/**"] },
      },
      custom: CUSTOM,
    });
    expect(read.checks).toEqual({
      "max-files-changed": { enabled: true, maxFiles: 20 },
      "max-lines-changed": { enabled: true, maxLines: 500 },
      "linked-issue": { enabled: true, tracker: "linear" },
      "no-merge-conflicts": { enabled: false },
      "ci-green": { enabled: false },
      "no-forbidden-paths": { enabled: true, forbiddenGlobs: ["vendor/**"] },
    });
    expect(read.custom).toEqual(CUSTOM);
    expect(readCheckPack(JSON.stringify(read))).toEqual(read);
    expect(readCheckPack({ ...emptyPack(REPO), checks: { size: { enabled: true, maxFiles: 20 } } }).checks).toEqual({
      "max-files-changed": { enabled: true, maxFiles: 20 },
      "max-lines-changed": { enabled: false },
    });
  });

  test("a custom rule's id never reads as a judge question's id", () => {
    for (const [name, id] of [["Docs sync", "rule-docs-sync"], ["Focused slice 001", "rule-focused-slice-001-rule"], ["Config file 1", "config-file-1-rule"], ["Schema hunk", "schema-hunk-rule"], ["Lockfile", "lockfile"]]) {
      expect(customRuleId(name!, [])).toBe(id!);
    }
    expect(customRuleId("Schema hunk", ["schema-hunk-rule"])).toBe("schema-hunk-rule-2");
    for (const id of ["docs-file-001", "focused-slice-001", "ticket-file-001", "ticket-hunk-001-002", "ticket-slice-2"]) {
      expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...CUSTOM[0]!, id }] })).toThrow(`Custom rule ${id} id must not start with docs- or focused- or end in -file, -hunk or -slice and numbers.`);
    }
  });

  test("a custom rule's id is its name in lowercase words, numbered past taken and built-in ids", () => {
    expect(customRuleId("Ticket in the title!", [])).toBe("ticket-in-the-title");
    expect(customRuleId("Ticket in the title", ["ticket-in-the-title", "ticket-in-the-title-2"])).toBe("ticket-in-the-title-3");
    expect(customRuleId("CI", [])).toBe("ci-2");
    expect(customRuleId("Focused", [])).toBe("rule-focused");
    expect(customRuleId("Ticket", ["ticket-4"])).toBe("ticket-5");
    expect(customRuleId("…", [])).toBe("rule");
    const named = { ...CUSTOM[0]!, id: customRuleId("Ticket", []) };
    expect(readCheckPack({ ...emptyPack(REPO), custom: [named] }).custom).toEqual([named]);
    expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...named, id: "ci-green" }] })).toThrow("Custom rule ci-green id must not be a built-in rule's id.");
    expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...named, id: "size" }] })).toThrow("Custom rule size id must not be a built-in rule's id.");
    expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...named, id: "state" }] })).toThrow("Custom rule state id must not be a built-in rule's id.");
    expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...named, id: "Ticket" }] })).toThrow("Custom rule Ticket id must be at most 64 lowercase letters, digits and single hyphens.");
  });

  test("legacy actions collapse into one policy: branches join their verdict's list, always joins all three, when is the union", () => {
    const DRAFT = { kind: "convert-to-draft", target: {}, automatic: true };
    const LABEL = { kind: "labels", target: { from: "type" } };
    const read = readCheckPack({
      ...emptyPack(REPO),
      mergeThreshold: 0.85,
      actions: [
        { id: "a", when: ["opened"], checks: ["ci", "custom-9"], branches: { yes: [{ ...COMMENT, automatic: true }], no: [DRAFT, REVIEW], unsure: [REVIEW] } },
        { id: "b", when: ["ready", "commented"], checks: ["draft"], branches: { no: [{ target: { role: "maintainers", to: "role" }, kind: "request-review" }] } },
        { id: "c", when: ["opened"], checks: [], branches: { always: [LABEL] } },
      ],
    });
    expect(read.actions).toEqual({ when: ["opened", "ready"], pass: [COMMENT, LABEL], fail: [REVIEW, LABEL], unsure: [REVIEW, LABEL] });
    expect(read).not.toHaveProperty("mergeThreshold");
  });

  test("a legacy action woken by no event a policy names is dropped, not widened", () => {
    const actions = [
      { id: "on-merge", when: ["merged", "closed"], checks: [], branches: { always: [COMMENT] } },
      { id: "on-review", when: ["commented", "reviewed", "approved", "changes-requested"], checks: ["ci"], branches: { no: [REVIEW] } },
    ];
    expect(readCheckPack({ ...emptyPack(REPO), actions }).actions).toEqual({ when: ["opened", "updated", "checks", "ready"], pass: [], fail: [], unsure: [] });
  });

  test("a legacy close or agent without checks stays held on Unsure and never joins Pass or Fail", () => {
    const AGENT = { kind: "agent", target: { prompt: "Fix it", tools: [] } };
    const CLOSE = { kind: "close", target: {} };
    const read = readCheckPack({ ...emptyPack(REPO), actions: [{ id: "a", when: "every", checks: [], branches: { always: [CLOSE, AGENT, COMMENT] } }] });
    expect(read.actions).toEqual({ when: ["opened", "updated", "checks", "ready"], pass: [COMMENT], fail: [COMMENT], unsure: [CLOSE, AGENT, COMMENT] });
  });

  test("legacy custom round-trip; blanks dropped; last duplicate id wins", () => {
    const custom = Array.from({ length: 10 }, (_, i) => customRow(i));
    custom.push({
      id: "custom-1",
      name: "Ticket in commit messages",
      group: "pull-request",
      instruction: "The pull request title or commit messages should mention a ticket id.",
    });
    const parsed = parseCheckPack({
      kind: "corbits.triage.check-pack",
      schemaVersion: 1,
      repo: REPO,
      custom,
    });
    expect(parsed?.custom).toHaveLength(7);
    expect(parsed?.custom[0]).toEqual({
      id: "custom-1",
      name: "Ticket in commit messages",
      group: "pull-request",
      kind: "model",
      shape: "is-true",
      claim: "The pull request title or commit messages should mention a ticket id.",
    });
    expect(parseCheckPack(JSON.stringify(parsed))).toEqual(parsed);
  });

  test("typed custom checks round-trip as written", () => {
    for (const custom of [RULES, MODELS, AUTHORS]) {
      const pack = { ...emptyPack(REPO), custom };
      expect(parseCheckPack(JSON.stringify(pack))).toEqual(pack);
    }
  });

  test("a custom check stores enabled only as false, and refuses anything but a boolean", () => {
    const read = readCheckPack({ ...emptyPack(REPO), custom: [{ ...RULES[0], enabled: true }, { ...RULES[1], enabled: false }] });
    expect(read.custom).toEqual([RULES[0], { ...RULES[1], enabled: false }]);
    expect(checkPackSchema({ ...emptyPack(REPO), custom: [{ ...RULES[1], enabled: false }] })).not.toBeInstanceOf(type.errors);
    expect(() => readCheckPack({ ...emptyPack(REPO), custom: [{ ...RULES[0], enabled: "no" }] })).toThrow("Custom rule custom-1 enabled must be true or false.");
  });

  test("an invalid typed custom check rejects the pack with its reason", () => {
    const rejected: Array<[unknown, string]> = [
      [{ ...RULES[2], pattern: "(" }, "Custom rule custom-3 pattern must be a valid regular expression without lookaround or backreferences"],
      [{ ...RULES[2], pattern: "a".repeat(201) }, "Custom rule custom-3 pattern must be at most 200 characters."],
      [{ ...RULES[2], pattern: "(?<=a)b" }, "Custom rule custom-3 pattern must be a valid regular expression without lookaround or backreferences"],
      [{ ...RULES[2], pattern: "(a)\\1" }, "Custom rule custom-3 pattern must be a valid regular expression without lookaround or backreferences"],
      [{ ...RULES[2], rule: "title-matches" }, "Custom rule custom-3 rule must be one of"],
      [{ ...MODELS[2], options: ["small", "small "] }, "Custom rule custom-3 options must not repeat a value."],
      [{ ...MODELS[2], failOn: ["medium"] }, "Custom rule custom-3 failOn must be among options."],
      [{ ...CUSTOM[0], when: ["migrations/**"] }, "Custom rule custom-1 when needs a file or hunk scope."],
      [{ ...RULES[0], globs: ["a".repeat(201)] }, "Custom rule custom-1 globs must be globs of at most 200 characters."],
      [{ ...RULES[0], globs: Array.from({ length: 51 }, (_, i) => `dir${i}/**`) }, "Custom rule custom-1 globs must list at most 50 globs."],
      [{ ...MODELS[3], scope: "repo" }, "Custom rule custom-4 scope must be one of"],
      [{ ...MODELS[1], scope: "file" }, "Custom rule custom-2 scope and when apply only to is-true checks."],
    ];
    for (const [row, reason] of rejected) {
      expect(() => readCheckPack({ ...emptyPack(REPO), custom: [row] })).toThrow(reason);
    }
  });

  test("a pattern with nested quantifiers is accepted, since rule checks match in linear time", () => {
    const pack = { ...emptyPack(REPO), custom: [{ ...RULES[2], pattern: "^(a+)+$" }] };
    expect(readCheckPack(pack)).toEqual(pack);
  });

  test("more custom checks than the cap reject the pack", () => {
    const custom = [...RULES, ...MODELS].map((row, i) => ({ ...row, id: `custom-${i + 1}` }));
    expect(() => readCheckPack({ ...emptyPack(REPO), custom })).toThrow("Policy must have at most 8 custom rules.");
  });

  test("a blank legacy row is dropped", () => {
    const blank = { id: "custom-1", name: "Ticket", group: "pull-request", instruction: " " };
    expect(parseCheckPack({ ...emptyPack(REPO), custom: [blank] })?.custom).toEqual([]);
  });

  test("corrupt kind, schema, or json is not a pack", () => {
    expect(parseCheckPack({ kind: "document", schemaVersion: 1, repo: REPO })).toBeNull();
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 2, repo: REPO })).toBeNull();
    expect(parseCheckPack("not json")).toBeNull();
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 1, repo: "nope" })).toBeNull();
  });

  test("actions round-trip, repeated Dos run once, a pack without actions runs nothing, and only a new pack asks a person on unsure", () => {
    expect(parseCheckPack({ ...emptyPack(REPO), custom: CUSTOM, actions: ACTIONS })?.actions).toEqual(ACTIONS);
    expect(parseCheckPack({ ...emptyPack(REPO), actions: { ...ACTIONS, fail: [COMMENT, COMMENT] } })?.actions.fail).toEqual([COMMENT]);
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 1, repo: REPO })?.actions).toEqual({ when: ["opened", "updated", "checks", "ready"], pass: [], fail: [], unsure: [] });
    expect(emptyPack(REPO).actions).toEqual(defaultActions());
    expect(defaultActions()).toEqual({ when: ["opened", "updated", "checks", "ready"], pass: [], fail: [], unsure: [{ kind: "request-review", target: { to: "codeowners" } }] });
  });

  test("invalid actions reject the pack with their reason", () => {
    const rejected: Array<[unknown, string]> = [
      [{ ...ACTIONS, when: ["commented"] }, "Actions when must be one of opened, updated, checks, ready."],
      [{ ...ACTIONS, when: [] }, "Actions when must be a non-empty list."],
      [{ ...ACTIONS, unsure: undefined }, "Actions must set exactly when, pass, fail, unsure."],
      [{ ...ACTIONS, pass: [{ kind: "comment", target: {} }] }, "Actions pass 1 target must set exactly body."],
      [[{ id: "a", when: "every", checks: [], branches: { maybe: [COMMENT] } }], "Action a branches must set only yes, no, unsure or always."],
    ];
    for (const [actions, reason] of rejected) expect(() => readCheckPack({ ...emptyPack(REPO), actions })).toThrow(reason);
  });

  test("the schema accepts what the parser reads, and a rejection says why", () => {
    const accepted = [
      { kind: "corbits.triage.check-pack", schemaVersion: 1, repo: REPO },
      { ...emptyPack(REPO), custom: CUSTOM, actions: ACTIONS },
      { ...emptyPack(REPO), custom: RULES },
      { ...emptyPack(REPO), custom: MODELS },
      { ...emptyPack(REPO), custom: AUTHORS },
      { ...emptyPack(REPO), actions: [{ id: "a", when: "every", checks: ["ci"], branches: { yes: [COMMENT] } }] },
      recommendedPack(REPO),
    ];
    for (const pack of accepted) {
      expect(checkPackSchema(pack)).not.toBeInstanceOf(type.errors);
      expect(parseCheckPack(pack)).not.toBeNull();
    }
    expect(checkPackSchema({ ...emptyPack(REPO), actions: { ...ACTIONS, always: [] } })).toBeInstanceOf(type.errors);
    expect(() => readCheckPack({ ...emptyPack(REPO), schemaVersion: 2 })).toThrow("schemaVersion must be 1.");
  });

  test("Use recommended keeps existing custom", () => {
    const started: CheckPack = {
      ...emptyPack(REPO),
      custom: CUSTOM,
    };
    const next = applyRecommended(started);
    expect(next.checks["max-files-changed"]?.enabled).toBe(true);
    expect(next.custom).toEqual(started.custom);
  });
});
