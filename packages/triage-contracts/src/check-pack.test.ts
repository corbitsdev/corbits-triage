// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import {
  applyRecommended,
  catalogCheckEnabled,
  emptyPack,
  parseCheckPack,
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
