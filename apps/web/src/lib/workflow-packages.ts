import type { RepoSource } from "@corbits/triage-contracts";

export type WorkflowPackage = {
  name: string;
  /** The pull request host whose credential the workflow binds; it deploys only while that host is connected. */
  source: RepoSource;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
};

// One pr-triage package per pull request host: each binds only its host's credential, and the hub deploys those of the
// hosts a workspace connected. pr-triage-historical reads GitHub only.
export const WORKFLOW_PACKAGES = [
  { name: "pr-triage-github", source: "github", packageName: "@corbits/pr-triage-github-workflow", entry: "./pr-triage-github.mjs", src: "src/pr-triage-github.ts" },
  { name: "pr-triage-bitbucket-datacenter", source: "bitbucket-datacenter", packageName: "@corbits/pr-triage-bitbucket-datacenter-workflow", entry: "./pr-triage-bitbucket-datacenter.mjs", src: "src/pr-triage-bitbucket-datacenter.ts" },
  { name: "pr-triage-historical", source: "github", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts" },
] as const satisfies readonly WorkflowPackage[];

export type PackageIndexEntry = { name: string; version: string; filename: string; integrity: string };
