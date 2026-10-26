// The policy file's v4 keys as a pull request's mail carries them, and the gate every pull request mail passes before
// the listener: a paused pull request starts no run, and in doubt nothing approves or merges unattended.
import { isDeepStrictEqual } from "node:util";
import { BLOCK_KINDS, decideOf, EVERYONE, repoSourceOf, VERDICTS, type BlockKind, type CheckPack, type CodeReviewProvider, type PolicyWorkflow, type RepoSource } from "@corbits/triage-contracts";
import type { PullRequestHead } from "../pull-request-reader.js";
import type { RepoRecord } from "./tenant-config.js";

/** `blocks` are those the variant runs; a policy turning any other on runs nowhere yet. */
export type PrWorkflowVariant = { source: RepoSource; provider: CodeReviewProvider; id: string; entry: string; blocks: readonly BlockKind[] };

export const PR_WORKFLOW_VARIANTS: readonly PrWorkflowVariant[] = [
  { source: "github", provider: "anthropic", id: "pr-workflow-anthropic-github", entry: "./pr-workflow-github.mjs", blocks: ["code-review"] },
  { source: "bitbucket-datacenter", provider: "anthropic", id: "pr-workflow-anthropic-bitbucket-datacenter", entry: "./pr-workflow-bitbucket-datacenter.mjs", blocks: ["code-review"] },
];

export function prWorkflowVariantOf(entryOrId: string): PrWorkflowVariant | undefined {
  return PR_WORKFLOW_VARIANTS.find((variant) => variant.entry === entryOrId || variant.id === entryOrId);
}

/**
 * The policy file's v4 keys when only the PR workflow can run them: a block is on, or `decide` is not the one pr-triage
 * runs from the pack's actions. Undefined otherwise, so the repository stays on pr-triage.
 */
export function prWorkflowKeys(workflow: PolicyWorkflow, pack: Pick<CheckPack, "actions">): PolicyWorkflow | undefined {
  const blocksOn = BLOCK_KINDS.some((kind) => workflow[kind]?.on === true);
  return blocksOn || (workflow.decide !== undefined && !isDeepStrictEqual(workflow.decide, decideOf(pack.actions, false))) ? workflow : undefined;
}

/** The trigger's part for the variant: code review's block as its scope reads it, gated on triage's rules unless it says otherwise, `decide`, and the blocks that are on. */
export function workflowPart(workflow: PolicyWorkflow | undefined) {
  if (!workflow) return {};
  const block = workflow["code-review"];
  const triage = block?.when?.triage;
  const codeReview = {
    on: block?.on === true,
    for: block?.for ?? [EVERYONE],
    triage: triage === undefined ? [...VERDICTS] : [triage].flat(),
    rules: block?.when?.rules ?? "pass",
    ...(block?.when?.paths && { paths: block.when.paths }),
    ...(block?.clean && { clean: block.clean }),
    ...(block?.provider && { provider: block.provider }),
  };
  const blocks = BLOCK_KINDS.filter((kind) => workflow[kind]?.on === true);
  return { codeReview, blocks, ...(workflow.decide && { decide: workflow.decide }) };
}

/** Only a person approves or merges a pull request whose policy writes its own `decide`, which no running workflow carries out. */
const HELD_UNDER_DECIDE = new Set(["approve", "merge"]);

export type PauseGateDeps = {
  /** The pull request as its host shows it now, without its diff. */
  readHead: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestHead>;
  log: (entry: Record<string, unknown>) => void;
};

/**
 * One pull request's mail as the listener gets it, or undefined when the pull request carries the policy's pause label:
 * no run starts. A head whose labels can't be read throws, to be retried. Only `pr` mails are gated.
 */
export function createPauseGate(deps: PauseGateDeps) {
  return async function gate(tenantId: string, record: RepoRecord, number: number, request: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    if (request["kind"] !== "pr") return request;
    const pauseLabel = request["pauseLabel"];
    // Only GitHub heads carry labels, so only there can a pause fire.
    if (typeof pauseLabel === "string" && repoSourceOf(request["repoSource"]) === "github") {
      const pull = await deps.readHead(tenantId, record, number);
      if (pull.labels?.includes(pauseLabel)) {
        deps.log({ level: "info", msg: "pr_paused", tenantId, repo: record.name, pr: number, headSha: request["headSha"], label: pauseLabel });
        return undefined;
      }
    }
    if (request["decide"] === undefined) return request;
    const automatic = Array.isArray(request["automatic"]) ? request["automatic"].filter((kind) => !HELD_UNDER_DECIDE.has(kind)) : [];
    return { ...request, automatic };
  };
}
