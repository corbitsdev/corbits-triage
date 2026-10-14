export type WorkflowEntry = { entry: `./${string}.mjs`; src: `src/${string}.ts` };

export type WorkflowPackage = WorkflowEntry & {
  name: string;
  packageName: string;
  /** The same definition built for other sets of pull request hosts; the hub deploys the one for the hosts a workspace connected. */
  variants?: readonly WorkflowEntry[];
};

export const WORKFLOW_PACKAGES = [
  {
    name: "pr-triage",
    packageName: "@corbits/pr-triage-workflow",
    entry: "./pr-triage.mjs",
    src: "src/pr-triage.ts",
    variants: [
      { entry: "./pr-triage-bitbucket-datacenter.mjs", src: "src/pr-triage-bitbucket-datacenter.ts" },
      { entry: "./pr-triage-github-bitbucket-datacenter.mjs", src: "src/pr-triage-github-bitbucket-datacenter.ts" },
    ],
  },
  { name: "pr-triage-historical", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts" },
] as const satisfies readonly WorkflowPackage[];

export type PackageIndexEntry = { name: string; version: string; filename: string; integrity: string };
