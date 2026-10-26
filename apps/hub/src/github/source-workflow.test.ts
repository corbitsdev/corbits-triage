import { expect, test } from "bun:test";
import { createHostRelease } from "./source-workflow.js";

test("disconnecting a host releases its listener and managers and leaves the other host's running", async () => {
  const live: Record<string, Array<{ runId: string; cancelling: boolean }>> = {
    "triage-listener-github": [{ runId: "run_gh_listener", cancelling: false }],
    "triage-manager-github": [{ runId: "run_gh_manager", cancelling: false }],
    "triage-listener-bitbucket-datacenter": [{ runId: "run_bb_listener", cancelling: false }],
    "triage-manager-bitbucket-datacenter": [{ runId: "run_bb_manager", cancelling: false }, { runId: "run_bb_stopping", cancelling: true }],
  };
  const cancelled: string[] = [];
  const release = createHostRelease({
    async connectedSources() {
      return ["github"];
    },
    async liveDeployments(_tenantId, workflow) {
      return live[workflow]!;
    },
    async cancel(_tenantId, runId) {
      cancelled.push(runId);
    },
    log() {},
  });
  await release("tnt");
  expect(cancelled).toEqual(["run_bb_listener", "run_bb_manager"]);
});
