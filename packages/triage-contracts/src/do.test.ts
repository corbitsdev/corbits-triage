import { expect, test } from "bun:test";
import { readPolicyFile } from "./policy-file.ts";
import { readCheckPack } from "./check-pack.ts";
import { policyKinds } from "./do.ts";
import type { DecideRule } from "./policy-workflow.ts";

const REPO = "acme/widgets";
const FILE = `rules:
  - check: ci-green
    text: CI passes.
    reason: Required.
    evidence: [maintainer-stated]
actions:
  pass: [{ do: assign, target: { to: author } }]
  unsure: [{ do: close }, { do: nothing }]
`;

test("a policy uses what Triage posts, what its steps and decide rules do, held kinds included, and only what the host can write", () => {
  const pack = readCheckPack(readPolicyFile(FILE, REPO), REPO);
  const decide: DecideRule[] = [{ if: { all: "clean" }, do: ["approve", "review"] }];
  expect(policyKinds(pack, decide, "github")).toEqual(["labels", "assign", "comment", "approve", "close"]);
  expect(policyKinds(pack, decide, "bitbucket-datacenter")).toEqual(["comment", "approve", "close"]);
});
