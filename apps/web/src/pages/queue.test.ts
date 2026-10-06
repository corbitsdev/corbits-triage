// SPDX-License-Identifier: GPL-2.0-only
import { describe, expect, test } from "bun:test";
import { filterTriageItems, sortTriageItems } from "../lib/triage-view.ts";

describe("Triage board filters", () => {
  test("splits requires-action, ready-to-merge, and all with humans first", () => {
    const human = {
      key: "acme/widgets#8",
      repo: "acme/widgets",
      number: 8,
      state: "needs-decision" as const,
      priority: "P0",
      owner: "ada",
      nextAction: "Confirm",
      confidence: 0.4,
      evidence: ["duplicate"],
      labels: [],
      comment: null,
      sha: null,
      degraded: null,
      needsHuman: true,
      pendingApprovalId: "mirror",
      runId: "run-1",
      waitingSince: "2026-05-10T00:00:00.000Z",
      canClose: true,
      pendingClose: false,
      href: "/triage/pr/acme/widgets/8",
    };
    const ready = { ...human, key: "acme/widgets#9", number: 9, state: "ready" as const, needsHuman: false, priority: "P3", pendingApprovalId: null };
    const stale = { ...human, key: "acme/widgets#10", number: 10, state: "stale" as const, needsHuman: false, priority: "P2", pendingApprovalId: null };
    const items = [ready, stale, human];
    expect(filterTriageItems(items, "action").map((item) => item.key)).toEqual(["acme/widgets#8"]);
    expect(filterTriageItems(items, "merge").map((item) => item.key)).toEqual(["acme/widgets#9"]);
    expect(sortTriageItems(filterTriageItems(items, "all")).map((item) => item.key)).toEqual([
      "acme/widgets#8",
      "acme/widgets#10",
      "acme/widgets#9",
    ]);
  });
});
