import { expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { shownReason } from "./pack-prose.ts";

test("messages name actions by place and custom checks by name; unknown ids are the one being built", () => {
  const always = { always: [{ kind: "close" as const, automatic: false, target: {} }] };
  const pack = {
    ...recommendedPack("acme/widgets"),
    custom: [{ id: "custom-1", name: "Conventional title", group: "pull-request" as const, kind: "rule" as const, rule: "title-pattern" as const, pattern: "^feat" }],
    actions: [{ id: "action-3", when: "every" as const, checks: [], branches: always }, { id: "action-1", when: "every" as const, checks: [], branches: always }],
  };
  expect(shownReason("Action action-1 checks only custom-1. Give it another check or remove the action first.", pack)).toBe("Action 2 checks only “Conventional title”. Give it another check or remove the action first.");
  expect(shownReason("Custom check custom-1 pattern must be a valid regular expression.", pack)).toBe("Check “Conventional title” pattern must be a valid regular expression.");
  expect(shownReason("Action action-4 branches always must not be empty.", pack)).toBe("This action branches always must not be empty.");
  expect(shownReason("Custom check custom-2 name must not be empty.", pack)).toBe("This check name must not be empty.");
});
