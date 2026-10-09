import { describe, expect, test } from "bun:test";
import { emptyPack, recommendedPack } from "@corbits/triage-contracts";
import { checkPackFromDraft, draftFromCheckPack, emptyDraft } from "./check-catalog.ts";

describe("draft pack conversion", () => {
  test("Use recommended round-trips to recommendedPack", () => {
    const rec = recommendedPack("acme/widgets");
    expect(checkPackFromDraft(draftFromCheckPack(rec, "human-approved"))).toEqual(rec);
  });

  test("empty customize is emptyPack", () => {
    expect(checkPackFromDraft(emptyDraft("acme/widgets"))).toEqual(emptyPack("acme/widgets"));
  });

  test("a check edit keeps the pack's actions", () => {
    const pack = {
      ...recommendedPack("acme/widgets"),
      actions: [{
        id: "thank",
        when: "every" as const,
        checks: [],
        branches: { always: [{ kind: "comment" as const, target: { body: "Thanks!" }, automatic: false }] },
      }],
    };
    const draft = draftFromCheckPack(pack);
    const edited = { ...draft, checks: draft.checks.map((row) => (row.id === "ci" ? { ...row, enabled: false } : row)) };
    expect(checkPackFromDraft(edited).actions).toEqual(pack.actions);
  });

  test("custom checks persist on custom[]", () => {
    const draft = emptyDraft("acme/widgets");
    draft.custom.push({
      id: "custom-1",
      enabled: true,
      custom: true,
      name: "No silent retries",
      group: "pr",
      instruction: "Fail if the diff retries without a budget.",
      values: { instruction: "Fail if the diff retries without a budget." },
    });
    expect(checkPackFromDraft(draft).custom).toEqual([{
      id: "custom-1",
      name: "No silent retries",
      group: "pull-request",
      instruction: "Fail if the diff retries without a budget.",
    }]);
  });
});
