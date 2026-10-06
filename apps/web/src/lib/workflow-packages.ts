// SPDX-License-Identifier: GPL-2.0-only

export type WorkflowPackage = {
  /** Workflow asset and definition name; the hub bridge routes mail by it. */
  name: string;
  packageName: string;
  entry: `./${string}.mjs`;
  src: `src/${string}.ts`;
};

export const WORKFLOW_PACKAGES = [
  { name: "pr-triage", packageName: "@corbits/pr-triage-workflow", entry: "./pr-triage.mjs", src: "src/pr-triage.ts" },
  { name: "pr-triage-historical", packageName: "@corbits/pr-triage-historical-workflow", entry: "./pr-triage-historical.mjs", src: "src/pr-triage-historical.ts" },
] as const satisfies readonly WorkflowPackage[];

/** Files of a built workflow package, served by the portal under `/workflows/<name>/`. */
export function workflowPackageFiles(workflow: WorkflowPackage): string[] {
  return ["package.json", workflow.entry.slice(2), "directors.mjs"];
}
