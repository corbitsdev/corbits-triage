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
      return { status: "ok", pack, source: { repo: { id: "a", version: 1 } }, automatic, ...(decide && { policyWorkflow: { decide } }) };
    },
  });
  const res = await handle({ repo: "acme/app" }, { tenantId: "t", principalId: "p" } as Parameters<typeof handle>[1]);
  return ((await res.json()) as { mergeRisks: unknown }).mergeRisks;
}

test("a rule that asks makes a CI change Unsure, where a merge on Pass is held", async () => {
  expect(await risks({ onFail: "ask", pass: [{ do: "merge", when: maintainers }], automatic: ["merge"] })).toEqual([]);
});

test("a decide merge for no author in particular admits first-time contributors", async () => {
  expect(await risks({ decide: [{ if: { triage: "pass" }, do: "merge" }], automatic: ["merge"] })).toEqual(["first-timers"]);
});

test("a decide approve that names no verdict lands only on Pass, so a CI change a rule fails stays out", async () => {
  expect(await risks({ decide: [{ if: { all: "clean", author: ["maintainers"] }, do: "approve" }], automatic: ["approve"] })).toEqual([]);
});

test("an approve on Fail lets a CI change through when no rule stops it", async () => {
  expect(await risks({ globs: [], fail: [{ do: "approve", when: maintainers }], automatic: ["approve"] })).toEqual(["ci-config"]);
});

test("an approve on Fail lets through the CI change a failing rule stops", async () => {
  expect(await risks({ fail: [{ do: "approve", when: maintainers }], automatic: ["approve"] })).toEqual(["ci-config"]);
});

test("forbidding one spelling or one workflow file leaves CI changes open", async () => {
  const pass: Step[] = [{ do: "merge", when: maintainers }];
  expect(await risks({ globs: [".github/workflows/*.yaml"], pass, automatic: ["merge"] })).toEqual(["ci-config"]);
  expect(await risks({ globs: [".github/workflows/ci.yml"], pass, automatic: ["merge"] })).toEqual(["ci-config"]);
});

test("the policy is read for the host named, GitHub when none is", async () => {
  const asked: string[] = [];
  const handle = createGithubPolicyRead({
    async readCheckPack(_tenantId, _repo, source) {
      asked.push(source);
      return { status: "missing" };
    },
  });
  const member = { tenantId: "t", principalId: "p" } as Parameters<typeof handle>[1];
  await handle({ repo: "acme/app", source: "bitbucket-datacenter" }, member);
  await handle({ repo: "acme/app" }, member);
  expect(asked).toEqual(["bitbucket-datacenter", "github"]);
});

test("says whether the policy file turns code review on", async () => {
  async function read(policyWorkflow?: { "code-review": { on: boolean } }): Promise<unknown> {
    const handle = createGithubPolicyRead({
      async readCheckPack() {
        return { status: "ok", pack: base, source: { repo: { id: "a", version: 1 } }, automatic: [], ...(policyWorkflow && { policyWorkflow }) };
      },
    });
    const res = await handle({ repo: "acme/app" }, { tenantId: "t", principalId: "p" } as Parameters<typeof handle>[1]);
    return ((await res.json()) as { codeReview: unknown }).codeReview;
  }
  expect(await read({ "code-review": { on: true } })).toBe(true);
  expect(await read({ "code-review": { on: false } })).toBe(false);
  expect(await read()).toBe(false);
});
