import { expect, test } from "bun:test";
import { DEFAULT_REPO_POLICY } from "@corbits/triage-contracts";
import { buildFacts } from "./facts.ts";

test("buildFacts carries the author's trust tier", () => {
  const facts = buildFacts("acme/widgets", 1, { author: "alice", authorAssociation: "MEMBER", branch: "a" }, [], [], [], DEFAULT_REPO_POLICY);
  expect(facts.tier).toBe("internal");
});
