import { expect, test } from "bun:test";
import { recommendedPack } from "@corbits/triage-contracts";
import { shownReason } from "./pack-prose.ts";

test("messages name custom rules by name; an unknown id is the one being built", () => {
  const pack = {
    ...recommendedPack("acme/widgets"),
    custom: [{ id: "custom-1", name: "Explains why", group: "pull-request" as const, kind: "model" as const, shape: "is-true" as const, claim: "The body says why." }],
  };
  expect(shownReason("Custom rule custom-1 claim must be a non-empty string.", pack)).toBe("Rule “Explains why” claim must be a non-empty string.");
  expect(shownReason("Custom rule custom-2 name must not be empty.", pack)).toBe("This rule name must not be empty.");
  expect(shownReason("Actions when must be a non-empty list.", pack)).toBe("When must be a non-empty list.");
});
