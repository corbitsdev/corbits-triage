import { type } from "arktype";
import { describe, expect, test } from "bun:test";
import {
  applyRecommended,
  catalogCheckEnabled,
  checkPackSchema,
  emptyPack,
  parseCheckPack,
  readCheckPack,
  recommendedPack,
  type Action,
  type CheckPack,
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

const CUSTOM = [{ id: "custom-1", name: "Ticket", group: "pull-request" as const, instruction: "Mention a ticket." }];
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

  test("custom round-trip; blanks dropped; cap 8; last duplicate id wins", () => {
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
      instruction: "The pull request title or commit messages should mention a ticket id.",
    });
    expect(parseCheckPack(JSON.stringify(parsed))).toEqual(parsed);
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

  test("Use recommended keeps existing custom", () => {
    const started: CheckPack = {
      ...emptyPack(REPO),
      custom: [{ id: "custom-1", name: "Ticket", group: "pull-request", instruction: "Mention a ticket." }],
    };
    const next = applyRecommended(started);
    expect(next.checks.draft?.enabled).toBe(true);
    expect(next.custom).toEqual(started.custom);
  });
});
