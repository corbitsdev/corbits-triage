export type WorkflowPackage = {
  name: string;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
};

export const WORKFLOW_PACKAGES = [
  { name: "pr-triage", packageName: "@corbits/pr-triage-workflow", entry: "./pr-triage.mjs", src: "src/pr-triage.ts" },
  { name: "pr-triage-historical", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts" },
] as const satisfies readonly WorkflowPackage[];

export type PackageIndexEntry = { name: string; version: string; filename: string; integrity: string };
