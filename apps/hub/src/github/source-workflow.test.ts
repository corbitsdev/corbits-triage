import { expect, test } from "bun:test";
import { createSourceDeployments, triageWorkflowOf } from "./source-workflow.js";

type Live = Record<string, Array<{ runId: string; cancelling: boolean }>>;

function harness(connected: Array<"github" | "bitbucket-datacenter">, live: Live) {
  const released: string[] = [];
  const logged: Array<Record<string, unknown>> = [];
  const reconcile = createSourceDeployments({
    connectedSources: async () => connected,
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

test("the pre-host workflow name and each package entry name a host's workflow", () => {
  expect(triageWorkflowOf("pr-triage")?.id).toBe("pr-triage-github");
  expect(triageWorkflowOf("./pr-triage-bitbucket-datacenter.mjs")?.source).toBe("bitbucket-datacenter");
  expect(triageWorkflowOf("./pr-triage-historical.mjs")).toBeUndefined();
});
