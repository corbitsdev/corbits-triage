import { expect, test } from "bun:test";
import { createSourceDeployments, triageWorkflowOf } from "./source-workflow.js";

type Live = Record<string, Array<{ runId: string; cancelling: boolean }>>;

type Host = "github" | "bitbucket-datacenter";

function harness(connected: Host[], live: Live, reviewed: Host[] = [], placed = true) {
  const released: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const reconcile = createSourceDeployments({
    connectedSources: async () => connected,
    codeReviewSources: async () => reviewed,
    codeReviewPlaced: async () => placed,
    liveDeployments: async (_tenantId, workflow) => live[workflow] ?? [],
    async release(_tenantId, runId) {
      released.push(runId);
    },
    log(entry) {
      logged.push(entry);
    },
  });
  return { reconcile, released, logged };
}

test("disconnecting a host releases its deployment; the pre-host pr-triage deployment goes once pr-triage-github is live", async () => {
  const h = harness(["github"], { "pr-triage-github": [{ runId: "run_gh", cancelling: false }], "pr-triage-bitbucket-datacenter": [{ runId: "run_bb", cancelling: false }], "pr-triage": [{ runId: "run_legacy", cancelling: false }] });
  await h.reconcile("tnt");
  expect(h.released).toEqual(["run_bb", "run_legacy"]);
  expect(h.logged.map((entry) => [entry.msg, entry.reason])).toEqual([["triage_deployment_released", "source_disconnected"], ["triage_deployment_released", "superseded_by_pr_triage_github"]]);
});

test("a host's code review stays deployed only while one of its repositories has it on and a provisioner can run it", async () => {
  const live = { "pr-triage-github": [{ runId: "run_gh", cancelling: false }], "pr-code-review-github": [{ runId: "run_review", cancelling: false }] };
  const on = harness(["github"], live, ["github"]);
  await on.reconcile("tnt");
  expect(on.released).toEqual([]);

  const off = harness(["github"], live);
  await off.reconcile("tnt");
  expect(off.released).toEqual(["run_review"]);
  expect(off.logged.map((entry) => entry.reason)).toEqual(["code_review_off"]);

  const nowhere = harness(["github"], live, ["github"], false);
  await nowhere.reconcile("tnt");
  expect(nowhere.released).toEqual(["run_review"]);
  expect(nowhere.logged.map((entry) => entry.reason)).toEqual(["no_isolated_place"]);
});

test("the pre-host workflow name and each package entry name a host's workflow", () => {
  expect(triageWorkflowOf("pr-triage")?.id).toBe("pr-triage-github");
  expect(triageWorkflowOf("./pr-triage-bitbucket-datacenter.mjs")?.source).toBe("bitbucket-datacenter");
  expect(triageWorkflowOf("./pr-triage-historical.mjs")).toBeUndefined();
});
