import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import {
  applyRecommended,
  catalogCheckEnabled,
  checkPackSchema,
  emptyPack,
  packMergeThreshold,
  parseCheckPack,
  readCheckPack,
  recommendedPack,
  type Action,
  type CheckPack,
  type CustomCheck,
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
  { id: "custom-3", name: "Title", group: "pull-request", kind: "rule", rule: "title-pattern", pattern: "^(feat|fix): " },
  { id: "custom-4", name: "Branch", group: "pull-request", kind: "rule", rule: "branch-pattern", pattern: "^cl-\\d+" },
  { id: "custom-5", name: "Labelled", group: "issue", kind: "rule", rule: "label-required", label: "triaged" },
  { id: "custom-6", name: "No debug", group: "code-vs-ci", kind: "rule", rule: "diff-excludes", pattern: "console\\.log" },
  { id: "custom-7", name: "Approved", group: "around", kind: "rule", rule: "min-approvals", count: 2 },
];
const MODELS: CustomCheck[] = [
  ...CUSTOM,
  { id: "custom-2", name: "Risk", group: "pull-request", kind: "model", shape: "score", subject: "safety", min: 6 },
  { id: "custom-3", name: "Size", group: "pull-request", kind: "model", shape: "choose", options: ["small", "large"], failOn: ["large"] },
];
const ACTIONS: Action[] = [
  {
    id: "review-ready",
    when: ["opened", "ready"],
    checks: ["ci", "custom-1"],
    branches: {
      yes: [{ kind: "request-review", target: { to: "role", role: "maintainers" }, automatic: true }],
      no: [{ kind: "comment", target: { body: "Please fix CI and link a ticket." }, automatic: false }],
      unsure: [{ kind: "labels", target: { from: "list", labels: ["needs-triage"] }, automatic: true }],
    },
  },
  {
    id: "label-type",
    when: "every",
    checks: [],
    branches: { always: [{ kind: "labels", target: { from: "type" }, automatic: true }] },
  },
];

const COMMENT = { kind: "comment", target: { body: "Thanks!" }, automatic: false };
const BASE = { id: "a", when: ["opened"], checks: ["ci"], branches: { yes: [COMMENT] } };

describe("check pack contract", () => {
  test("add one catalog check; unknown ids ignored; absent keys empty", () => {
    const parsed = parseCheckPack({
      kind: "corbits.triage.check-pack",
      schemaVersion: 1,
      repo: REPO,
      checks: {
        draft: { enabled: true },
        notACheck: { enabled: true },
        size: { enabled: false, maxFiles: 10, maxLines: 100 },
      },
    });
    expect(parsed?.checks).toEqual({
      draft: { enabled: true },
      size: { enabled: false, maxFiles: 10, maxLines: 100 },
    });
    expect(parsed?.custom).toEqual([]);
    expect(catalogCheckEnabled(parsed!, "draft")).toBe(true);
    expect(catalogCheckEnabled(parsed!, "size")).toBe(false);
    expect(catalogCheckEnabled(parsed!, "ci")).toBe(false);
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
    for (const custom of [RULES, MODELS]) {
      const pack = { ...emptyPack(REPO), custom };
      expect(parseCheckPack(JSON.stringify(pack))).toEqual(pack);
    }
  });

  test("an invalid typed custom check rejects the pack with its reason", () => {
    const rejected: Array<[unknown, string]> = [
      [{ ...RULES[2], pattern: "(" }, "Custom check custom-3 pattern must be a valid regular expression."],
      [{ ...RULES[2], pattern: "a".repeat(201) }, "Custom check custom-3 pattern must be at most 200 characters."],
      [{ ...RULES[2], rule: "title-matches" }, "Custom check custom-3 rule must be one of"],
      [{ ...MODELS[2], options: ["small", "small "] }, "Custom check custom-3 options must not repeat a value."],
      [{ ...MODELS[2], failOn: ["medium"] }, "Custom check custom-3 failOn must be among options."],
    ];
    for (const [row, reason] of rejected) {
      expect(() => readCheckPack({ ...emptyPack(REPO), custom: [row] })).toThrow(reason);
    }
  });

  test("more custom checks than the cap reject the pack", () => {
    const custom = [...RULES, ...MODELS].map((row, i) => ({ ...row, id: `custom-${i + 1}` }));
    expect(() => readCheckPack({ ...emptyPack(REPO), custom })).toThrow("Check pack must have at most 8 custom checks.");
  });

  test("a blank legacy row is dropped and cannot be referenced", () => {
    const blank = { id: "custom-1", name: "Ticket", group: "pull-request", instruction: " " };
    expect(parseCheckPack({ ...emptyPack(REPO), custom: [blank] })?.custom).toEqual([]);
    expect(parseCheckPack({ ...emptyPack(REPO), custom: [blank], actions: [{ ...BASE, checks: ["custom-1"] }] })).toBeNull();
  });

  test("corrupt kind, schema, or json is not a pack", () => {
    expect(parseCheckPack({ kind: "document", schemaVersion: 1, repo: REPO })).toBeNull();
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 2, repo: REPO })).toBeNull();
    expect(parseCheckPack("not json")).toBeNull();
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 1, repo: "nope" })).toBeNull();
  });

  test("actions round-trip; legacy pack without actions parses with none", () => {
    expect(parseCheckPack({ ...emptyPack(REPO), custom: CUSTOM, actions: ACTIONS })?.actions).toEqual(ACTIONS);
    expect(parseCheckPack({ kind: "corbits.triage.check-pack", schemaVersion: 1, repo: REPO })?.actions).toEqual([]);
  });

  test("invalid actions reject the pack", () => {
    const close = { kind: "close", target: {}, automatic: true };
    const rejected = [
      { ...BASE, when: ["pushed"] },
      { ...BASE, when: ["catch-up"] },
      { ...BASE, checks: ["custom-9"] },
      { ...BASE, branches: {} },
      { ...BASE, branches: { always: [COMMENT] } },
      { ...BASE, checks: [] },
      { ...BASE, branches: { unsure: [close] } },
      { ...BASE, checks: [], branches: { always: [close] } },
    ];
    expect(parseCheckPack({ ...emptyPack(REPO), actions: [BASE] })?.actions).toHaveLength(1);
    for (const action of rejected) expect(parseCheckPack({ ...emptyPack(REPO), actions: [action] })).toBeNull();
  });

  test("the schema accepts what the parser reads, and a rejection says why", () => {
    const accepted = [
      { kind: "corbits.triage.check-pack", schemaVersion: 1, repo: REPO },
      { ...emptyPack(REPO), custom: CUSTOM, actions: ACTIONS },
      { ...emptyPack(REPO), custom: RULES },
      { ...emptyPack(REPO), custom: MODELS },
      { ...emptyPack(REPO), actions: [BASE] },
      recommendedPack(REPO),
    ];
    for (const pack of accepted) {
      expect(checkPackSchema(pack)).not.toBeInstanceOf(type.errors);
      expect(parseCheckPack(pack)).not.toBeNull();
    }
    expect(() => readCheckPack({ ...emptyPack(REPO), schemaVersion: 2 })).toThrow("schemaVersion must be 1.");
    expect(() => readCheckPack({ ...emptyPack(REPO), actions: [{ ...BASE, checks: ["custom-9"] }] })).toThrow(
      "Action a checks custom-9 must be a catalog check or a custom check in this pack.",
    );
  });

  test("an absent merge threshold reads 0.7; one out of range rejects the pack", () => {
    expect(packMergeThreshold(readCheckPack(emptyPack(REPO)))).toBe(0.7);
    expect(packMergeThreshold(readCheckPack({ ...emptyPack(REPO), mergeThreshold: 0.85 }))).toBe(0.85);
    for (const mergeThreshold of [-0.1, 1.1, "0.8"]) {
      expect(() => readCheckPack({ ...emptyPack(REPO), mergeThreshold })).toThrow("Merge score threshold must be between 0 and 1.");
      expect(checkPackSchema({ ...emptyPack(REPO), mergeThreshold })).toBeInstanceOf(type.errors);
    }
  });

  test("Use recommended keeps existing custom", () => {
    const started: CheckPack = {
      ...emptyPack(REPO),
      custom: CUSTOM,
    };
    const next = applyRecommended(started);
    expect(next.checks.draft?.enabled).toBe(true);
    expect(next.custom).toEqual(started.custom);
  });
});
