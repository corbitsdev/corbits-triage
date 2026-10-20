import { expect, test } from "bun:test";
import { projectLiveToInert, type WorkflowDefinition } from "@intx/workflow";

import codeReviewPackage from "../packages/pr-code-review-anthropic/package.json";
import { workflow as codeReview } from "../packages/pr-code-review-anthropic/src/pr-code-review";
import { workflow as codeReviewBitbucket } from "../packages/pr-code-review-anthropic/src/pr-code-review-bitbucket-datacenter";
import { workflow as codeReviewGithub } from "../packages/pr-code-review-anthropic/src/pr-code-review-github";
import triagePackage from "../packages/triage-workflows/package.json";
import { workflow as triage } from "../packages/triage-workflows/src/pr-triage";
import { workflow as triageBitbucket } from "../packages/triage-workflows/src/pr-triage-bitbucket-datacenter";
import { workflow as triageGithub } from "../packages/triage-workflows/src/pr-triage-github";
import { workflow as triageHistorical } from "../packages/triage-workflows/src/pr-triage-historical";

/** Each workflow entry the packages declare, by package and entry path. */
const SHIPPED: Record<string, WorkflowDefinition> = {
  "triage-workflows/src/pr-triage.ts": triage,
  "triage-workflows/src/pr-triage-historical.ts": triageHistorical,
  "triage-workflows/src/pr-triage-github.ts": triageGithub,
  "triage-workflows/src/pr-triage-bitbucket-datacenter.ts": triageBitbucket,
  "pr-code-review-anthropic/src/pr-code-review.ts": codeReview,
  "pr-code-review-anthropic/src/pr-code-review-github.ts": codeReviewGithub,
  "pr-code-review-anthropic/src/pr-code-review-bitbucket-datacenter.ts": codeReviewBitbucket,
};

// Read tools confined to the checkout or the pull request's head; refusal of paths leaving the checkout is tested in repo-read-tool.
const ALLOWED = new Set(["read_file", "grep", "list", "github_read_file", "bitbucket_datacenter_read_file"]);

type ModelStep = { workflow: string; step: string; tools: string[]; capabilities: unknown[] };

function entriesOf(workspace: string, workflows: Record<string, string>) {
  return Object.values(workflows).map((entry) => `${workspace}/${entry.replace("./", "")}`);
}

function modelSteps(workflow: string, node: unknown, step = ""): ModelStep[] {
  if (!node || typeof node !== "object") return [];
  const found: ModelStep[] = [];
  const { kind, agent } = node as { kind?: string; agent?: { toolFactories: { definitions: { name: string }[] }[]; capabilities: unknown[] } };
  if (kind === "step" && agent) {
    const tools = agent.toolFactories.flatMap((factory) => factory.definitions.map((definition) => definition.name));
    found.push({ workflow, step, tools, capabilities: agent.capabilities });
  }
  for (const [key, value] of Object.entries(node)) found.push(...modelSteps(workflow, value, step ? `${step}.${key}` : key));
  return found;
}

test("every workflow the packages declare is checked", () => {
  const declared = [...entriesOf("triage-workflows", triagePackage.interchange.workflows), ...entriesOf("pr-code-review-anthropic", codeReviewPackage.interchange.workflows)];
  expect(Object.keys(SHIPPED).sort()).toEqual(declared.sort());
});

test("model steps get only checkout-confined read tools", () => {
  const steps = Object.entries(SHIPPED).flatMap(([entry, workflow]) => modelSteps(entry, projectLiveToInert(workflow)));
  expect(steps.length).toBeGreaterThan(0);
  for (const { workflow, step, tools, capabilities } of steps) {
    expect({ workflow, step, tools: tools.filter((tool) => !ALLOWED.has(tool)), capabilities }).toEqual({ workflow, step, tools: [], capabilities: [] });
  }
});
