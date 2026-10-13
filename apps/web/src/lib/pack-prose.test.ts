import { expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { shownReason } from "./pack-prose.ts";

test("messages name verdict lists and custom rules by name; an unknown id is the one being built", () => {
  const pack = {
    ...recommendedPack("acme/widgets"),
    custom: [{ id: "custom-1", name: "Conventional title", group: "pull-request" as const, kind: "rule" as const, rule: "title-pattern" as const, pattern: "^feat" }],
  };
  expect(shownReason("Custom rule custom-1 pattern must be a valid regular expression.", pack)).toBe("Rule “Conventional title” pattern must be a valid regular expression.");
  expect(shownReason("Custom rule custom-2 name must not be empty.", pack)).toBe("This rule name must not be empty.");
  expect(shownReason("Actions unsure 1 target must set exactly body.", pack)).toBe("On Unsure 1 target must set exactly body.");
});
