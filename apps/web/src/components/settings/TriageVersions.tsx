import { TRIAGE_LISTENERS, type RepoSource } from "@corbits/triage-contracts";
import { currentDeployment } from "../../lib/hub-api.ts";
import { hostFullName } from "../../lib/pull-link.ts";
import type { DeployedSection } from "../../lib/tenant-entities.ts";

/** One sentence on what runs; the host is named only when there are several. */
function runningText(deployed: DeployedSection, source: RepoSource, named: boolean): string {
  const on = named ? ` on ${hostFullName(source)}` : "";
  const listener = currentDeployment(deployed.rows, TRIAGE_LISTENERS[source]);
  if (!listener) return `Triage is starting${on}.`;
  const what = listener.package ? `version ${listener.package.version}` : "the current version";
  return `Triage${on} runs ${what}, started ${new Date(listener.createdAt).toLocaleString()}.`;
}

function failedText(deployed: DeployedSection, source: RepoSource, named: boolean): string | undefined {
  const error = deployed.rollouts.find((rollout) => rollout.source === source)?.error;
  if (error === undefined) return undefined;
  return named ? `${hostFullName(source)}: ${error}` : error;
}

function HostVersion({ deployed, source, named }: { deployed: DeployedSection; source: RepoSource; named: boolean }) {
  const failed = failedText(deployed, source, named);
  return (
    <div className="sentence">
      <span className="txt">{runningText(deployed, source, named)}</span>
      {failed && <p role="alert" className="field-error">{failed}</p>}
    </div>
  );
}

/** The version each connected host runs and when it started; a sentence on the last update when it failed. */
export function TriageVersions({ deployed, sources }: { deployed: DeployedSection; sources: readonly RepoSource[] }) {
  if (deployed.loading || deployed.denied || deployed.unavailable) return null;
  return <>{sources.map((source) => <HostVersion key={source} deployed={deployed} source={source} named={sources.length > 1} />)}</>;
}
