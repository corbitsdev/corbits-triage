import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { CHAIN_PACKAGES } from "../../lib/workflow-packages.ts";
import type { HubPrincipal } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { usePrincipals } from "../../lib/tenant-entities.ts";
import { portalRelease, UPGRADE_STEP_LABEL, upgradeDue, useMayUpgrade, useTriageRelease, useTriageUpgrade, type RunningListener, type TriageRelease, type UpgradeStep } from "../../lib/triage-upgrade.ts";
import type { RepoSource } from "@corbits/triage-contracts";

const SOURCE_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket Data Center" };
const SUMMARY = "Each pull request gets one manager that posts a single update.";

function publisherName(principalId: string | null, people: readonly HubPrincipal[]): string {
  const person = people.find((row) => row.id === principalId);
  if (!person) return "someone no longer in this workspace";
  return person.displayName || (person.email ?? person.id);
}

function runningText(running: RunningListener, people: readonly HubPrincipal[], hosts: number): string {
  const where = hosts > 1 ? ` on ${SOURCE_NAME[running.source]}` : "";
  const what = running.release === undefined ? "the new workflow" : `release ${running.release}`;
  return `Triage runs ${what}${where}, published by ${publisherName(running.publisherPrincipalId, people)}.`;
}

function AdvancedInfo({ release, sources, people }: { release: TriageRelease; sources: readonly RepoSource[]; people: readonly HubPrincipal[] }) {
  const chain = CHAIN_PACKAGES.filter((row) => sources.includes(row.source));
  return (
    <details className="upgrade-info">
      <summary>Advanced info</summary>
      <ul>
        {sources.map((source) => <li key={source}>This portal's release{sources.length > 1 && ` for ${SOURCE_NAME[source]}`}: {portalRelease(release.portal, source) ?? "none"}</li>)}
        {release.running.map((running) => (
          <li key={running.source}>Running{sources.length > 1 && ` on ${SOURCE_NAME[running.source]}`}: {running.release === undefined ? "the new workflow" : `release ${running.release}`}, published by {publisherName(running.publisherPrincipalId, people)} on {new Date(running.since).toLocaleString()}</li>
        ))}
        {chain.map((row) => <li key={row.name}><span className="mono">{row.name}</span> {release.portal.find((entry) => entry.workflow === row.name)?.hash ?? "not in this release"}</li>)}
      </ul>
    </details>
  );
}

/** Which release of the per-pull-request manager runs, and the switch to this portal's: a deprecation notice while a workspace has none. */
export function TriageUpgrade({ sources }: { sources: readonly RepoSource[] }) {
  const { readOnly } = usePortal();
  const people = usePrincipals();
  const release = useTriageRelease();
  const mayUpgrade = useMayUpgrade();
  const [step, setStep] = useState<UpgradeStep | null>(null);
  const upgrade = useTriageUpgrade(setStep);

  if (!release.data) return null;
  const oldPath = release.data.running.length === 0;
  const due = upgradeDue(release.data, sources);

  return (
    <>
      {oldPath && <div className="sentence"><span className="txt">Triage runs on its old workflow, which is being retired. Upgrade to keep it working.</span></div>}
      {release.data.running.map((running) => <div className="sentence" key={running.source}><span className="txt">{runningText(running, people.rows, sources.length)}</span></div>)}
      {due && (
        <div className="sentence">
          <span className="txt">{oldPath ? SUMMARY : `A new version is ready. ${SUMMARY}`}</span>
          {mayUpgrade && (
            <Button type="button" size="sm" disabled={readOnly || upgrade.isPending} onClick={() => upgrade.mutate()}>
              {upgrade.isPending && step ? UPGRADE_STEP_LABEL[step] : "Upgrade to new version"}
            </Button>
          )}
        </div>
      )}
      {due && !mayUpgrade && <p className="muted small-text">Ask a workspace owner or a Deployer to upgrade.</p>}
      {upgrade.error && <p role="alert" className="field-error">Could not upgrade. {errorText(upgrade.error)}</p>}
      <AdvancedInfo release={release.data} sources={sources} people={people.rows} />
    </>
  );
}
