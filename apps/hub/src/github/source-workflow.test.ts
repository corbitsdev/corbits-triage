import { expect, test } from "bun:test";
import { triageWorkflowOf } from "./source-workflow.js";

test("the pre-host workflow name and each package entry name a host's workflow", () => {
  expect(triageWorkflowOf("pr-triage")?.id).toBe("pr-triage-github");
  expect(triageWorkflowOf("./pr-triage-bitbucket-datacenter.mjs")?.source).toBe("bitbucket-datacenter");
  expect(triageWorkflowOf("./pr-triage-historical.mjs")).toBeUndefined();
});
