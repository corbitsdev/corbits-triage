import { expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { shownReason } from "./pack-prose.ts";

test("messages name actions by place and custom rules by name; unknown ids are the one being built", () => {
  const always = { always: [{ kind: "close" as const, target: {} }] };
  const pack = {
    ...recommendedPack("acme/widgets"),
    custom: [
      { id: "custom-1", name: "Conventional title", group: "pull-request" as const, kind: "rule" as const, rule: "title-pattern" as const, pattern: "^feat" },
      { id: "no-debug", name: "No debug", group: "code-vs-ci" as const, kind: "rule" as const, rule: "diff-excludes" as const, pattern: "debugger" },
    ],
    actions: [{ id: "action-3", when: "every" as const, checks: [], branches: always }, { id: "action-1", when: "every" as const, checks: [], branches: always }],
  };
  expect(shownReason("Action action-1 checks only custom-1. Give it another rule or remove the action first.", pack)).toBe("Action 2 checks only “Conventional title”. Give it another rule or remove the action first.");
  expect(shownReason("Action action-3 checks no-debug must be a built-in rule, the not-a-draft rule or a custom rule in this policy.", pack)).toBe("Action 1 checks “No debug” must be a built-in rule, the not-a-draft rule or a custom rule in this policy.");
  expect(shownReason("Custom rule custom-1 pattern must be a valid regular expression.", pack)).toBe("Rule “Conventional title” pattern must be a valid regular expression.");
  expect(shownReason("Custom rule no-debug pattern must be a valid regular expression.", pack)).toBe("Rule “No debug” pattern must be a valid regular expression.");
  expect(shownReason("Action action-4 branches always must not be empty.", pack)).toBe("This action branches always must not be empty.");
  expect(shownReason("Custom rule custom-2 name must not be empty.", pack)).toBe("This rule name must not be empty.");
});
