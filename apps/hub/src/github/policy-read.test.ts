import { expect, test } from "bun:test";
import { recommendedPack, type ActionKind, type CheckPack, type DecideRule, type RepoSource, type Step } from "@corbits/triage-contracts";
import { createGithubPolicyRead } from "./policy-read.js";

const base = recommendedPack("acme/app");
const maintainers: Step["when"] = { author: [{ group: "maintainers" }] };

type Case = { globs?: string[]; onFail?: "ask" | "label"; pass?: Step[]; fail?: Step[]; decide?: DecideRule[]; automatic: ActionKind[]; source?: RepoSource };

async function risks({ globs = [".github/**"], onFail, pass = [], fail = [], decide, automatic, source = "github" }: Case): Promise<unknown> {
  const pack: CheckPack = { ...base, checks: { ...base.checks, "no-forbidden-paths": { enabled: true, forbiddenGlobs: globs, ...(onFail && { onFail }) } }, actions: { ...base.actions, pass, fail, unsure: [] } };
  const handle = createGithubPolicyRead({
    async readCheckPack() {
      return { status: "ok", pack, source: { repo: { id: "a", version: 1 } }, automatic, ...(decide && { policyWorkflow: { decide } }) };
    },
    async repoSource() {
      return source;
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

test("an approve on Fail lets through the CI change a failing rule stops", async () => {
  expect(await risks({ fail: [{ do: "approve", when: maintainers }], automatic: ["approve"] })).toEqual(["ci-config"]);
});

test("forbidding workflow files stops CI changes; forbidding one file does not", async () => {
  const pass: Step[] = [{ do: "merge", when: maintainers }];
  expect(await risks({ globs: [".github/workflows/*.yaml"], pass, automatic: ["merge"] })).toEqual(["ci-config"]);
  expect(await risks({ globs: [".github/workflows/ci.yml"], pass, automatic: ["merge"] })).toEqual(["ci-config"]);
});

test("Bitbucket Data Center repositories name no merge risks", async () => {
  expect(await risks({ globs: [], pass: [{ do: "merge" }], automatic: ["merge"], source: "bitbucket-datacenter" })).toEqual([]);
});
