import type { CodeReviewProvider, RepoSource } from "@corbits/triage-contracts";
import type { DeclaredModel } from "./model-catalog.ts";

/**
 * Triage deploys once its host is connected; code review deploys only while a repository of its host has it on; the PR
 * workflow, triage then code review, while a connected repository's policy file needs it and its provider's key is stored.
 */
export type WorkflowKind = "triage" | "code-review" | "pr-workflow";

/** `workspace` is the package under packages/ its source lives in; code review and the PR workflow have one per provider, and a workspace deploys its provider's. */
type Kind =
  | { kind: "triage"; workspace: "triage-workflows" }
  | { kind: "code-review"; provider: CodeReviewProvider; workspace: `pr-code-review-${CodeReviewProvider}` }
  | { kind: "pr-workflow"; provider: CodeReviewProvider; workspace: `pr-workflow-${CodeReviewProvider}` };

/** Where a release's workflow comes from: the package under packages/ and its entry, built into its own package. */
export type BuiltPackage = {
  /** The workflow's name, which its hub address and deployment go by whatever package it comes from. */
  name: string;
  workspace: string;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
  /** The catalog models the workflow's agents name; the first is its default source. */
  models: readonly [DeclaredModel, ...DeclaredModel[]];
};

export type WorkflowPackage = Kind & BuiltPackage & {
  /** The pull request host whose credential the workflow binds; it deploys only while that host is connected. */
  source: RepoSource;
};

// One pr-triage package per pull request host: each binds only its host's credential, and the hub deploys those of the
// hosts a workspace connected. pr-triage-historical reads GitHub only. Code review is the same per host.
export const WORKFLOW_PACKAGES = [
  { name: "pr-triage-github", kind: "triage", workspace: "triage-workflows", source: "github", packageName: "@corbits/pr-triage-github-workflow", entry: "./pr-triage-github.mjs", src: "src/pr-triage-github.ts", models: ["decision"] },
  { name: "pr-triage-bitbucket-datacenter", kind: "triage", workspace: "triage-workflows", source: "bitbucket-datacenter", packageName: "@corbits/pr-triage-bitbucket-datacenter-workflow", entry: "./pr-triage-bitbucket-datacenter.mjs", src: "src/pr-triage-bitbucket-datacenter.ts", models: ["decision"] },
  { name: "pr-triage-historical", kind: "triage", workspace: "triage-workflows", source: "github", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts", models: ["decision"] },
  { name: "pr-code-review-github", kind: "code-review", provider: "anthropic", workspace: "pr-code-review-anthropic", source: "github", packageName: "@corbits/pr-code-review-github-workflow", entry: "./pr-code-review-github.mjs", src: "src/pr-code-review-github.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-code-review-bitbucket-datacenter", kind: "code-review", provider: "anthropic", workspace: "pr-code-review-anthropic", source: "bitbucket-datacenter", packageName: "@corbits/pr-code-review-bitbucket-datacenter-workflow", entry: "./pr-code-review-bitbucket-datacenter.mjs", src: "src/pr-code-review-bitbucket-datacenter.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-workflow-anthropic-github", kind: "pr-workflow", provider: "anthropic", workspace: "pr-workflow-anthropic", source: "github", packageName: "@corbits/pr-workflow-anthropic-github-workflow", entry: "./pr-workflow-github.mjs", src: "src/pr-workflow-github.ts", models: ["decision", "claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-workflow-anthropic-bitbucket-datacenter", kind: "pr-workflow", provider: "anthropic", workspace: "pr-workflow-anthropic", source: "bitbucket-datacenter", packageName: "@corbits/pr-workflow-anthropic-bitbucket-datacenter-workflow", entry: "./pr-workflow-bitbucket-datacenter.mjs", src: "src/pr-workflow-bitbucket-datacenter.ts", models: ["decision", "claude-opus-5-5", "claude-haiku-5-5"] },
] as const satisfies readonly WorkflowPackage[];

export type PackageIndexEntry = { name: string; version: string; filename: string; integrity: string };

/** A workflow of the manager chain; one that deploys others is published after them, with each release under `as`. */
export type ChainPackage = BuiltPackage & { source: RepoSource; deploys?: readonly { workflow: string; as: "codeReview" | "manager" | "judge" }[] };

// Each host's listener deploys its manager, which deploys its code review and its judge, so they publish in this order.
export const CHAIN_PACKAGES = [
  { name: "pr-code-review-reviewer-github", workspace: "pr-code-review-anthropic", source: "github", packageName: "@corbits/pr-code-review-reviewer-github-workflow", entry: "./pr-code-review-reviewer-github.mjs", src: "src/pr-code-review-reviewer-github.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-code-review-reviewer-bitbucket-datacenter", workspace: "pr-code-review-anthropic", source: "bitbucket-datacenter", packageName: "@corbits/pr-code-review-reviewer-bitbucket-datacenter-workflow", entry: "./pr-code-review-reviewer-bitbucket-datacenter.mjs", src: "src/pr-code-review-reviewer-bitbucket-datacenter.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "triage-judge-github", workspace: "triage-judge", source: "github", packageName: "@corbits/triage-judge-github-workflow", entry: "./triage-judge-github.mjs", src: "src/triage-judge-github.ts", models: ["decision"] },
  { name: "triage-judge-bitbucket-datacenter", workspace: "triage-judge", source: "bitbucket-datacenter", packageName: "@corbits/triage-judge-bitbucket-datacenter-workflow", entry: "./triage-judge-bitbucket-datacenter.mjs", src: "src/triage-judge-bitbucket-datacenter.ts", models: ["decision"] },
  { name: "triage-manager-github", workspace: "triage-manager", source: "github", packageName: "@corbits/triage-manager-github-workflow", entry: "./triage-manager-github.mjs", src: "src/triage-manager-github.ts", models: ["decision"], deploys: [{ workflow: "pr-code-review-reviewer-github", as: "codeReview" }, { workflow: "triage-judge-github", as: "judge" }] },
  { name: "triage-manager-bitbucket-datacenter", workspace: "triage-manager", source: "bitbucket-datacenter", packageName: "@corbits/triage-manager-bitbucket-datacenter-workflow", entry: "./triage-manager-bitbucket-datacenter.mjs", src: "src/triage-manager-bitbucket-datacenter.ts", models: ["decision"], deploys: [{ workflow: "pr-code-review-reviewer-bitbucket-datacenter", as: "codeReview" }, { workflow: "triage-judge-bitbucket-datacenter", as: "judge" }] },
  { name: "triage-listener-github", workspace: "triage-manager", source: "github", packageName: "@corbits/triage-listener-github-workflow", entry: "./triage-listener-github.mjs", src: "src/triage-listener-github.ts", models: ["decision"], deploys: [{ workflow: "triage-manager-github", as: "manager" }] },
  { name: "triage-listener-bitbucket-datacenter", workspace: "triage-manager", source: "bitbucket-datacenter", packageName: "@corbits/triage-listener-bitbucket-datacenter-workflow", entry: "./triage-listener-bitbucket-datacenter.mjs", src: "src/triage-listener-bitbucket-datacenter.ts", models: ["decision"], deploys: [{ workflow: "triage-manager-bitbucket-datacenter", as: "manager" }] },
] as const satisfies readonly ChainPackage[];

/** A release's workflow as a source tree: `sources/<workflow>-<hash>.json`, where `hash` is its build's content hash. */
export type SourceIndexEntry = { workflow: string; hash: string };
/** Each file's path in the source asset mapped to its contents. */
export type SourceTree = Record<string, string>;
