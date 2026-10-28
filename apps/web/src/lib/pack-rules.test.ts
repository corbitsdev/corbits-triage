import { expect, test } from "bun:test";
import { emptyPack, recommendedPack, starterPack, type CheckPack, type CustomCheck } from "@corbits/triage-contracts";
import { policyNeedsModel } from "./pack-rules.ts";

const repo = "acme/widgets";

function pack(overrides: Partial<CheckPack>): CheckPack {
  return { ...emptyPack(repo), ...overrides };
}

test("a policy needs a model only while a judgement rule is on", () => {
  const judged: CustomCheck = { id: "custom-1", name: "Reversible", group: "code-vs-ci", kind: "model", shape: "is-true", claim: "The migration can be rolled back.", scope: "file", when: ["migrations/**"] };
  const text: CustomCheck = { id: "notes", name: "Notes", group: "pull-request", kind: "text", fields: ["title"], failWhen: "contains", phrases: ["wip"] };
  expect(policyNeedsModel(emptyPack(repo))).toBe(false);
  expect(policyNeedsModel(starterPack(repo))).toBe(false);
  expect(policyNeedsModel(pack({ custom: [text], checks: { "ci-green": { enabled: true } } }))).toBe(false);
  expect(policyNeedsModel(pack({ custom: [{ ...judged, enabled: false }] }))).toBe(false);
  expect(policyNeedsModel(pack({ checks: { focused: { enabled: false } } }))).toBe(false);
  expect(policyNeedsModel(recommendedPack(repo))).toBe(true);
  expect(policyNeedsModel(pack({ checks: { focused: { enabled: true } } }))).toBe(true);
  expect(policyNeedsModel(pack({ custom: [judged] }))).toBe(true);
});
