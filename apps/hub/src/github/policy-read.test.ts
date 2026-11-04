import { expect, test } from "bun:test";
import { recommendedPack, type ActionKind, type CheckPack, type DecideRule, type Step } from "@corbits/triage-contracts";
import { createGithubPolicyRead } from "./policy-read.js";

const base = recommendedPack("acme/app");
const maintainers: Step["when"] = { author: [{ group: "maintainers" }] };

type Case = { globs?: string[]; onFail?: "ask" | "label"; pass?: Step[]; fail?: Step[]; decide?: DecideRule[]; automatic: ActionKind[] };

async function risks({ globs = [".github/**"], onFail, pass = [], fail = [], decide, automatic }: Case): Promise<unknown> {
  const pack: CheckPack = { ...base, checks: { ...base.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: globs, ...(onFail && { onFail }) } }, actions: { ...base.actions, pass, fail, unsure: [] } };
  const handle = createGithubPolicyRead({
    async readCheckPack() {
      return { status: "ok", pack, source: { file: { path: ".corbits-triage.yml", sha: "a" } }, automatic, ...(decide && { policyWorkflow: { decide } }) };
    },
  });
  const res = await handle({ repo: "acme/app" }, { tenantId: "t", principalId: "p" } as Parameters<typeof handle>[1]);
  return ((await res.json()) as { mergeRisks: unknown }).mergeRisks;
}

test("a decide merge for no author in particular admits first-time contributors", async () => {
  expect(await risks({ decide: [{ if: { triage: "pass" }, do: "merge" }], automatic: ["merge"] })).toEqual(["first-timers"]);
});

test("an approve on Fail lets through the CI change a failing rule stops", async () => {
  expect(await risks({ fail: [{ do: "approve", when: maintainers }], automatic: ["approve"] })).toEqual(["ci-config"]);
});

test("says whether the policy file turns code review on", async () => {
  async function read(policyWorkflow?: { "code-review": { on: boolean } }): Promise<unknown> {
    const handle = createGithubPolicyRead({
      async readCheckPack() {
        return { status: "ok", pack: base, source: { file: { path: ".corbits-triage.yml", sha: "a" } }, automatic: [], ...(policyWorkflow && { policyWorkflow }) };
      },
    });
    const res = await handle({ repo: "acme/app" }, { tenantId: "t", principalId: "p" } as Parameters<typeof handle>[1]);
    return ((await res.json()) as { codeReview: unknown }).codeReview;
  }
  expect(await read({ "code-review": { on: true } })).toBe(true);
  expect(await read({ "code-review": { on: false } })).toBe(false);
  expect(await read()).toBe(false);
});
