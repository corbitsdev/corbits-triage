import { usePortal } from "../lib/portal.tsx";
import { upgradeDue, useMayUpgrade, useTriageRelease } from "../lib/triage-upgrade.ts";
import { UpgradeOffer } from "./settings/TriageUpgrade.tsx";

/** The Settings upgrade, at the top of the main pages, for someone who may upgrade while a host is due. */
export function TriageUpgradeBanner() {
  const { snapshot } = usePortal();
  const mayUpgrade = useMayUpgrade();
  const release = useTriageRelease(mayUpgrade);

  if (!release.data || !mayUpgrade || snapshot?.decisionModel === undefined) return null;
  const data = release.data;
  const due = data.hosts.filter((host) => upgradeDue(data, host));
  if (due.length === 0) return null;

  return (
    <section className="upgrade-banner" aria-label="Upgrade Triage">
      <UpgradeOffer release={data} hosts={due} />
    </section>
  );
}
