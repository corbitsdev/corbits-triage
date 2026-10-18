import { expect, test } from "bun:test";
import { projectLiveToInert } from "@intx/workflow";
import { workflow as bitbucket } from "./pr-code-review-bitbucket-datacenter.js";
import { workflow as github } from "./pr-code-review-github.js";

test("every deployed code review requires a sidecar of its own", () => {
  for (const definition of [github, bitbucket]) {
    expect(projectLiveToInert(definition).sidecarPlacement).toEqual({ capabilities: [{ capability: "isolation:workload", effect: "require" }] });
  }
});
