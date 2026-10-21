// Picks the workflow a pull request's mail runs: its host's pr-triage, or, while the policy file turns a block on or
// writes its own `decide`, the PR workflow variant of the provider whose key the workspace stores, which triages, runs
// the blocks and decides once. Only key names are read, never secrets. In doubt nothing approves or merges unattended.
import { isDeepStrictEqual } from "node:util";
import { asRecord, errorText } from "@corbits/common";
import { BLOCK_KINDS, CODE_REVIEW_PROVIDERS, codeReviewProviderOf, decideOf, EVERYONE, repoSourceOf, VERDICTS, type BlockKind, type CheckPack, type CodeReviewProvider, type PolicyWorkflow, type RepoSource } from "@corbits/triage-contracts";
import { reviewRequestOf, type PullRequestToReview } from "../code-review-feed.js";
import type { TriageJob } from "./coordinator.js";
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

/** The trigger's part for the variant: code review's block as its scope reads it, `decide`, and the blocks that are on. */
export function workflowPart(workflow: PolicyWorkflow | undefined) {
  if (!workflow) return {};
  const block = workflow["code-review"];
  const triage = block?.when?.triage;
  const codeReview = {
    on: block?.on === true,
    for: block?.for ?? [EVERYONE],
    triage: triage === undefined ? [...VERDICTS] : [triage].flat(),
    ...(block?.when?.paths && { paths: block.when.paths }),
    ...(block?.clean && { clean: block.clean }),
    ...(block?.provider && { provider: block.provider }),
  };
  const blocks = BLOCK_KINDS.filter((kind) => workflow[kind]?.on === true);
  return { codeReview, blocks, ...(workflow.decide && { decide: workflow.decide }) };
}

/** The host's variant for the policy's provider, else the first in the default order whose key is stored; undefined without that key. */
export function variantFor(source: RepoSource, provider: unknown, credentials: readonly string[]): PrWorkflowVariant | undefined {
  const chosen = provider ?? codeReviewProviderOf(credentials);
  return PR_WORKFLOW_VARIANTS.find((variant) => variant.source === source && variant.provider === chosen && credentials.includes(CODE_REVIEW_PROVIDERS[variant.provider].credential));
}

/** Only a person approves or merges a pull request whose policy no running workflow can carry out. */
const HELD_WITHOUT_VARIANT = new Set(["approve", "merge"]);

export type PrWorkflowRouterDeps = {
  /** The names of the workspace's active code review provider credentials. */
  credentials: (tenantId: string) => Promise<string[]>;
  live: (tenantId: string, workflow: string) => Promise<boolean>;
  /** The pull request as its host shows it now. */
  readPull: (tenantId: string, record: RepoRecord, number: number) => Promise<PullRequestToReview>;
  log: (entry: Record<string, unknown>) => void;
};

export function createPrWorkflowRouter(deps: PrWorkflowRouterDeps) {
  /** Undefined when it cannot be read: the run goes ahead unpaused, and records a review it needed incomplete. */
  async function pullOf(job: TriageJob, record: RepoRecord): Promise<PullRequestToReview | undefined> {
    try {
      return await deps.readPull(job.tenantId, record, job.number);
    } catch (err) {
      deps.log({ level: "warn", msg: "pull_request_unread", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, error: errorText(err) });
      return undefined;
    }
  }

  /** The review of the job's head, or undefined when the pull request has moved on or its diff is unusable. */
  function reviewOf(job: TriageJob, record: RepoRecord, pull: PullRequestToReview): object | undefined {
    if (pull.headSha !== job.headSha) return undefined;
    try {
      return reviewRequestOf(record, job.number, pull);
    } catch (err) {
      deps.log({ level: "warn", msg: "code_review_unread", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, error: errorText(err) });
      return undefined;
    }
  }

  /** The variant that runs the mail, or why none can. */
  async function variantOf(job: TriageJob, request: Record<string, unknown>, blocks: readonly unknown[]): Promise<PrWorkflowVariant | string> {
    const variant = variantFor(repoSourceOf(request["repoSource"]), asRecord(request["codeReview"])?.["provider"], await deps.credentials(job.tenantId));
    if (!variant) return "no_provider_key";
    if (!blocks.every((kind) => variant.blocks.some((runs) => runs === kind))) return "block_not_runnable";
    if (!(await deps.live(job.tenantId, variant.id))) return "variant_not_running";
    return variant;
  }

  /** Undefined when the pull request carries the policy's pause label: no run starts. */
  return async function route(job: TriageJob): Promise<TriageJob | undefined> {
    const request = asRecord(job.payload);
    if (!request || request["kind"] !== "pr") return job;
    const blocks = request["blocks"];
    const pauseLabel = request["pauseLabel"];
    const reviewed = Array.isArray(blocks) && asRecord(request["codeReview"])?.["on"] === true;
    if (reviewed && !job.record) deps.log({ level: "warn", msg: "code_review_unread", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, reason: "no_record" });
    const pull = job.record && (typeof pauseLabel === "string" || reviewed) ? await pullOf(job, job.record) : undefined;
    if (typeof pauseLabel === "string" && pull?.labels?.includes(pauseLabel)) {
      deps.log({ level: "info", msg: "pr_paused", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, label: pauseLabel });
      return undefined;
    }
    if (!Array.isArray(blocks)) return job;
    const variant = await variantOf(job, request, blocks);
    if (typeof variant === "string") {
      deps.log({ level: "warn", msg: "pr_workflow_unavailable", tenantId: job.tenantId, repo: job.repo, pr: job.number, headSha: job.headSha, reason: variant });
      const automatic = Array.isArray(request["automatic"]) ? request["automatic"].filter((kind) => !HELD_WITHOUT_VARIANT.has(kind)) : [];
      return { ...job, payload: { ...request, automatic } };
    }
    const codeReviewRequest = reviewed && job.record && pull ? reviewOf(job, job.record, pull) : undefined;
    return { ...job, workflow: variant.id, payload: { ...request, ...(codeReviewRequest && { codeReviewRequest }) } };
  };
}
