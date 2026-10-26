import type { RepoSource } from "@corbits/triage-contracts";
import type { DeclaredModel } from "./model-catalog.ts";

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
