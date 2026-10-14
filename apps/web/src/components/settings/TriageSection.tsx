import { Link } from "react-router-dom";
import { DeniedNotice } from "../../lib/denied.tsx";
import { currentDeployment, type DeployedWorkflow, type RepoRecord } from "../../lib/hub-api.ts";
import { counted } from "../../lib/plural.ts";
import { triageEnabledRepos } from "../../lib/repo-rows.ts";
import type { TenantSection } from "../../lib/tenant-entities.ts";
import { WORKFLOW_PACKAGES } from "../../lib/workflow-packages.ts";
import { CopyButton } from "../CopyField.tsx";

const TRIAGE_WORKFLOW = "pr-triage";

/** Each workflow's version, then the tools those deployments carry, each once, as one line to paste into a bug report. */
function versionLine(deployments: readonly DeployedWorkflow[]): string {
  const parts: string[] = [];
  const tools = new Set<string>();
  for (const workflow of WORKFLOW_PACKAGES) {
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

function statusText(running: boolean, enabled: number, total: number): string {
  if (!running) return "Triage is not running: its workflow is not deployed.";
  if (total === 0) return "Triage is running, but no repository is connected yet.";
  return `Triage is running on ${enabled} of ${counted(total, "repository", "repositories")}.`;
}

/** Whether triage runs, where, what decides a verdict, and the versions it runs. */
export function TriageSection({ repos, deployed }: { repos: RepoRecord[]; deployed: TenantSection<DeployedWorkflow> }) {
  const ready = !deployed.denied && !deployed.loading && !deployed.unavailable;
  const running = currentDeployment(deployed.rows, TRIAGE_WORKFLOW) !== undefined;
  const versions = versionLine(deployed.rows);

  return (
    <section className="sec" id="triage" aria-labelledby="sec-triage">
      <header>
        <h2 id="sec-triage">Triage</h2>
        <p>Every new or updated pull request in an enabled repository gets a verdict: Pass, Fail or Unsure.</p>
      </header>
      <div>
        {deployed.denied && <DeniedNotice section="workflow deployments" />}
        {ready && (
          <div className="sentences">
            <div className="sentence">
              <span className="txt">{statusText(running, triageEnabledRepos(repos).size, repos.length)}</span>
              <Link className="linkish" to="/repositories">Choose repositories</Link>
            </div>
            <div className="sentence">
              <span className="txt">A failed hard rule decides Fail on its own; otherwise the decision model answers one question to choose the verdict.</span>
            </div>
            <div className="sentence">
              <code className="txt mono small-text">{versions}</code>
              <CopyButton value={versions} label="Copy the versions Triage runs" />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
