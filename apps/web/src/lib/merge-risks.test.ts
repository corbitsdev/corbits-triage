import { expect, test } from "bun:test";
import { recommendedPack, type CheckPack, type Step } from "@corbits/triage-contracts";
import { mergeRisks } from "./merge-risks.ts";

const base = recommendedPack("acme/app");

function withPass(pass: Step[], checks: CheckPack["checks"] = base.checks): CheckPack {
  return { ...base, checks, actions: { ...base.actions, pass } };
}

test.each([
  ["approve is not allowed", withPass([{ do: "approve" }]), ["comment"], [], undefined],
  ["merge waits on an unsure verdict", { ...base, actions: { ...base.actions, pass: [], unsure: [{ do: "merge" }] } }, ["merge"], [], undefined],
  ["any author is approved", withPass([{ do: "approve" }]), ["approve"], [], ["first-timers"]],
  ["maintainers only", withPass([{ do: "merge", when: { author: [{ group: "maintainers" }] } }]), ["merge"], [], []],
  ["external authors", withPass([{ do: "merge", when: { author: [{ group: "external" }] } }]), ["merge"], [], ["first-timers"]],
  ["first-time contributor kind", withPass([{ do: "approve", when: { author: ["FIRST_TIME_CONTRIBUTOR"] } }]), ["approve"], [], ["first-timers"]],
  ["CI configuration only labelled", withPass([{ do: "approve", when: { author: ["OWNER"] } }], { ...base.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: [".github/**"], onFail: "label" } }), ["approve"], [], ["ci-config"]],
  ["no forbidden paths", withPass([{ do: "approve", when: { author: ["OWNER"] } }], {}), ["approve"], [], ["ci-config"]],
  ["decide merges", withPass([]), ["merge"], ["merge"], []],
] as const)("%s", (_name, pack, automatic, decide, risks) => {
  expect(mergeRisks(pack as CheckPack, automatic, decide)).toEqual(risks);
});
