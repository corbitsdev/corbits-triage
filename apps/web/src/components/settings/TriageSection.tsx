import { Link } from "react-router-dom";
import { DeniedNotice } from "../../lib/denied.tsx";
import { hasDecisionModelCredential } from "../../lib/decision-models.ts";
import { currentDeployment, type DeployedWorkflow, type PortalSnapshot } from "../../lib/hub-api.ts";
import { counted } from "../../lib/plural.ts";
import { triageReadyRepos } from "../../lib/repo-rows.ts";
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

type Status = { deployed: boolean; model: boolean; triaging: number; total: number };

function statusText({ deployed, model, triaging, total }: Status): string {
  if (!deployed) return "Triage is not running: its workflow is not deployed.";
  if (!model) return "Triage is not running: no decision model is connected.";
  if (total === 0) return "Triage is running, but no repository is connected yet.";
  return `Triage is running on ${triaging} of ${counted(total, "repository", "repositories")}.`;
}

export function TriageSection({ snapshot, deployed }: { snapshot: PortalSnapshot; deployed: TenantSection<DeployedWorkflow> }) {
  const ready = !deployed.denied && !deployed.loading && !deployed.unavailable;
  const status = {
    deployed: currentDeployment(deployed.rows, TRIAGE_WORKFLOW) !== undefined,
    model: hasDecisionModelCredential(snapshot.credentials),
    triaging: triageReadyRepos(snapshot.repos).size,
    total: snapshot.repos.length,
  };
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
              <span className="txt">{statusText(status)}</span>
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
