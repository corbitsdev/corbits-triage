import type { RepoSource } from "@corbits/triage-contracts";
import { currentDeployment, type DeployedWorkflow } from "../../lib/hub-api.ts";
import { WORKFLOW_PACKAGES } from "../../lib/workflow-packages.ts";
import { CopyButton } from "../CopyField.tsx";

/** Each connected host's workflows' versions, then the tools those deployments carry, each once, as one line to paste into a bug report. */
function versionLine(deployments: readonly DeployedWorkflow[], sources: readonly RepoSource[]): string {
  const parts: string[] = [];
  const tools = new Set<string>();
  for (const workflow of WORKFLOW_PACKAGES.filter((row) => sources.includes(row.source))) {
    const deployment = currentDeployment(deployments, workflow.name);
    if (!deployment) {
      parts.push(`${workflow.name} not deployed`);
      continue;
    }
    parts.push(`${workflow.name} ${deployment.package?.version ?? "not from the package registry"}`);
    for (const tool of deployment.tools) tools.add(`${tool.name} ${tool.version}`);
  }
  return [...parts, ...tools].join(" · ");
}

export function SupportVersions({ deployments, sources }: { deployments: readonly DeployedWorkflow[]; sources: readonly RepoSource[] }) {
  const versions = versionLine(deployments, sources);
  return (
    <details className="support-versions">
      <summary>Versions for support</summary>
      <div className="sentence">
        <code className="txt mono small-text">{versions}</code>
        <CopyButton value={versions} label="Copy the versions Triage runs" />
      </div>
    </details>
  );
}
