import { expect, test } from "bun:test";
import { projectLiveToInert, type WorkflowDefinition } from "@intx/workflow";

import codeReviewPackage from "../packages/pr-code-review-anthropic/package.json";
import { workflow as codeReview } from "../packages/pr-code-review-anthropic/src/pr-code-review";
import { workflow as codeReviewReviewerBitbucket } from "../packages/pr-code-review-anthropic/src/pr-code-review-reviewer-bitbucket-datacenter";
import { workflow as codeReviewReviewerGithub } from "../packages/pr-code-review-anthropic/src/pr-code-review-reviewer-github";
import judgePackage from "../packages/triage-judge/package.json";
import { workflow as judgeBitbucket } from "../packages/triage-judge/src/triage-judge-bitbucket-datacenter";
import { workflow as judgeGithub } from "../packages/triage-judge/src/triage-judge-github";
import managerPackage from "../packages/triage-manager/package.json";
import { workflow as listenerBitbucket } from "../packages/triage-manager/src/triage-listener-bitbucket-datacenter";
import { workflow as listenerGithub } from "../packages/triage-manager/src/triage-listener-github";
import { workflow as managerBitbucket } from "../packages/triage-manager/src/triage-manager-bitbucket-datacenter";
import { workflow as managerGithub } from "../packages/triage-manager/src/triage-manager-github";

/** Each workflow entry the packages declare, by package and entry path. */
const SHIPPED: Record<string, WorkflowDefinition> = {
  "pr-code-review-anthropic/src/pr-code-review.ts": codeReview,
  "pr-code-review-anthropic/src/pr-code-review-reviewer-github.ts": codeReviewReviewerGithub,
  "pr-code-review-anthropic/src/pr-code-review-reviewer-bitbucket-datacenter.ts": codeReviewReviewerBitbucket,
  "triage-judge/src/triage-judge-github.ts": judgeGithub,
  "triage-judge/src/triage-judge-bitbucket-datacenter.ts": judgeBitbucket,
  "triage-manager/src/triage-manager-github.ts": managerGithub,
  "triage-manager/src/triage-manager-bitbucket-datacenter.ts": managerBitbucket,
  "triage-manager/src/triage-listener-github.ts": listenerGithub,
  "triage-manager/src/triage-listener-bitbucket-datacenter.ts": listenerBitbucket,
};

/** The mail agent's director runs its one tool on the step's input and never calls a model. */
const NO_MODEL = new Set(["triage-mail", "triage-mail-tolerant"]);

// Read tools confined to the checkout or the pull request's head; refusal of paths leaving the checkout is tested in repo-read-tool.
const ALLOWED = new Set(["read_file", "grep", "list", "github_read_file", "bitbucket_datacenter_read_file"]);

type ModelStep = { workflow: string; step: string; tools: string[]; capabilities: unknown[] };

function entriesOf(workspace: string, workflows: Record<string, string>) {
  return Object.values(workflows).map((entry) => `${workspace}/${entry.replace("./", "")}`);
}

function modelSteps(workflow: string, node: unknown, step = ""): ModelStep[] {
  if (!node || typeof node !== "object") return [];
  const found: ModelStep[] = [];
  const { kind, agent } = node as { kind?: string; agent?: { id: string; toolFactories: { definitions: { name: string }[] }[]; capabilities: unknown[] } };
  if (kind === "step" && agent && !NO_MODEL.has(agent.id)) {
    const tools = agent.toolFactories.flatMap((factory) => factory.definitions.map((definition) => definition.name));
    found.push({ workflow, step, tools, capabilities: agent.capabilities });
  }
  for (const [key, value] of Object.entries(node)) found.push(...modelSteps(workflow, value, step ? `${step}.${key}` : key));
  return found;
}

test("every workflow the packages declare is checked", () => {
  const declared = [...entriesOf("pr-code-review-anthropic", codeReviewPackage.interchange.workflows), ...entriesOf("triage-judge", judgePackage.interchange.workflows), ...entriesOf("triage-manager", managerPackage.interchange.workflows)];
  expect(Object.keys(SHIPPED).sort()).toEqual(declared.sort());
});

test("model steps get only checkout-confined read tools", () => {
  const steps = Object.entries(SHIPPED).flatMap(([entry, workflow]) => modelSteps(entry, projectLiveToInert(workflow)));
  expect(steps.length).toBeGreaterThan(0);
  for (const { workflow, step, tools, capabilities } of steps) {
    expect({ workflow, step, tools: tools.filter((tool) => !ALLOWED.has(tool)), capabilities }).toEqual({ workflow, step, tools: [], capabilities: [] });
  }
});
