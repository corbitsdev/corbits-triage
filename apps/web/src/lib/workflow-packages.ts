import type { CodeReviewProvider, RepoSource } from "@corbits/triage-contracts";
import type { DeclaredModel } from "./model-catalog.ts";

/** Triage deploys once its host is connected; code review deploys only while a repository of its host has it on. */
export type WorkflowKind = "triage" | "code-review";

/** `workspace` is the package under packages/ its source lives in; code review has one per provider, and a workspace deploys its provider's. */
type Kind = { kind: "triage"; workspace: "triage-workflows" } | { kind: "code-review"; provider: CodeReviewProvider; workspace: `pr-code-review-${CodeReviewProvider}` };

export type WorkflowPackage = Kind & {
  /** The workflow's name, which its hub address and deployment go by whatever package it comes from. */
  name: string;
  /** The pull request host whose credential the workflow binds; it deploys only while that host is connected. */
  source: RepoSource;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
  /** The catalog models the workflow's agents name; the first is its default source. */
  models: readonly [DeclaredModel, ...DeclaredModel[]];
};

// One pr-triage package per pull request host: each binds only its host's credential, and the hub deploys those of the
// hosts a workspace connected. pr-triage-historical reads GitHub only. Code review is the same per host.
export const WORKFLOW_PACKAGES = [
  { name: "pr-triage-github", kind: "triage", workspace: "triage-workflows", source: "github", packageName: "@corbits/pr-triage-github-workflow", entry: "./pr-triage-github.mjs", src: "src/pr-triage-github.ts", models: ["decision"] },
  { name: "pr-triage-bitbucket-datacenter", kind: "triage", workspace: "triage-workflows", source: "bitbucket-datacenter", packageName: "@corbits/pr-triage-bitbucket-datacenter-workflow", entry: "./pr-triage-bitbucket-datacenter.mjs", src: "src/pr-triage-bitbucket-datacenter.ts", models: ["decision"] },
  { name: "pr-triage-historical", kind: "triage", workspace: "triage-workflows", source: "github", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts", models: ["decision"] },
  { name: "pr-code-review-github", kind: "code-review", provider: "anthropic", workspace: "pr-code-review-anthropic", source: "github", packageName: "@corbits/pr-code-review-github-workflow", entry: "./pr-code-review-github.mjs", src: "src/pr-code-review-github.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
  { name: "pr-code-review-bitbucket-datacenter", kind: "code-review", provider: "anthropic", workspace: "pr-code-review-anthropic", source: "bitbucket-datacenter", packageName: "@corbits/pr-code-review-bitbucket-datacenter-workflow", entry: "./pr-code-review-bitbucket-datacenter.mjs", src: "src/pr-code-review-bitbucket-datacenter.ts", models: ["claude-opus-5-5", "claude-haiku-5-5"] },
] as const satisfies readonly WorkflowPackage[];

export type PackageIndexEntry = { name: string; version: string; filename: string; integrity: string };
