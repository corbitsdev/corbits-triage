import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { RepoSource } from "@corbits/triage-contracts";
import { CHAIN_PACKAGES } from "../../lib/workflow-packages.ts";
import type { HubPrincipal } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { hostFullName } from "../../lib/pull-link.ts";
import { usePrincipals } from "../../lib/tenant-entities.ts";
import { portalRelease, UPGRADE_STEP_LABEL, upgradeDue, useMayUpgrade, useTriageRelease, useTriageUpgrade, type HostRelease, type TriageRelease, type UpgradeStep } from "../../lib/triage-upgrade.ts";

const SUMMARY = "Each pull request gets one manager that posts a single update.";

function publisherName(principalId: string | null, people: readonly HubPrincipal[]): string {
  const person = people.find((row) => row.id === principalId);
  if (!person) return "someone no longer in this workspace";
  return person.displayName || (person.email ?? person.id);
}

/** One sentence per connected host; the host is named only when there are several. */
function hostText(release: TriageRelease, host: HostRelease, people: readonly HubPrincipal[], named: boolean): string {
  const on = named ? ` on ${hostFullName(host.source)}` : "";
  if (!host.running) return `Triage is stopped${on} until it is upgraded.`;
  const what = host.running.version === undefined ? "the new workflow" : `version ${host.running.version}`;
  const ran = `Triage${on} runs ${what}, published by ${publisherName(host.running.publisherPrincipalId, people)}.`;
  if (host.live > 1) return `${ran} Another copy is still running too; upgrade to stop it.`;
  if (upgradeDue(release, host)) return `${ran} A new version is ready.`;
  return ran;
}

function AdvancedInfo({ release, people }: { release: TriageRelease; people: readonly HubPrincipal[] }) {
  const named = release.hosts.length > 1;
  const sources: RepoSource[] = release.hosts.map((host) => host.source);
  const chain = CHAIN_PACKAGES.filter((row) => sources.includes(row.source));
  return (
    <details className="upgrade-info">
      <summary>Advanced info</summary>
      <ul>
        {release.hosts.map((host) => <li key={`portal-${host.source}`}>This portal's release{named && ` for ${hostFullName(host.source)}`}: {portalRelease(release.portal, host.source) ?? "none"}</li>)}
        {release.hosts.map((host) => host.running && (
          <li key={`running-${host.source}`}>Running{named && ` on ${hostFullName(host.source)}`}: {host.running.release === undefined ? "the new workflow" : `release ${host.running.release}`}, published by {publisherName(host.running.publisherPrincipalId, people)} on {new Date(host.running.since).toLocaleString()}</li>
        ))}
        {chain.map((row) => <li key={row.name}><span className="mono">{row.name}</span> {release.portal.find((entry) => entry.workflow === row.name)?.hash ?? "not in this release"}</li>)}
      </ul>
    </details>
  );
}

/** Which version of the per-pull-request manager each host runs, and the switch to this portal's; a deprecation notice for a host that has none. */
export function TriageUpgrade() {
  const { readOnly } = usePortal();
  const people = usePrincipals();
  const release = useTriageRelease();
  const mayUpgrade = useMayUpgrade();
  const [step, setStep] = useState<UpgradeStep | null>(null);
  const upgrade = useTriageUpgrade(setStep);

  if (!release.data) return null;
  const data = release.data;
  const named = data.hosts.length > 1;
  const due = data.hosts.some((host) => upgradeDue(data, host));

  return (
    <>
      {data.hosts.map((host) => <div className="sentence" key={host.source}><span className="txt">{hostText(data, host, people.rows, named)}</span></div>)}
      {due && (
        <div className="sentence">
          <span className="txt">{SUMMARY}</span>
          {mayUpgrade && (
            <Button type="button" size="sm" disabled={readOnly || upgrade.isPending} onClick={() => upgrade.mutate()}>
              {upgrade.isPending && step ? UPGRADE_STEP_LABEL[step] : "Upgrade to new version"}
            </Button>
          )}
        </div>
      )}
      {due && !mayUpgrade && <p className="muted small-text">Ask a workspace owner or a Deployer to upgrade.</p>}
      {upgrade.error && <p role="alert" className="field-error">Could not upgrade. {errorText(upgrade.error)}</p>}
      <AdvancedInfo release={data} people={people.rows} />
    </>
  );
}
