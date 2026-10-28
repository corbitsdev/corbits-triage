import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, StatusDot } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { bitbucketDatacenterRepoUrl, useBitbucketDatacenterConnection, useBitbucketDatacenterManualWebhook } from "../../lib/bitbucket-datacenter.ts";
import type { RepoRecord } from "../../lib/hub-api.ts";
import { checkPackQuery, packOf } from "../../lib/check-packs.ts";
import { hasRuleOn, policyNeedsModel } from "../../lib/pack-rules.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useTriageSwitch } from "../../lib/repo-triage.ts";
import { useRepoStats, type StatsReader } from "../../lib/repo-stats.ts";
import type { RepoRow } from "../../lib/repo-rows.ts";
import { CloseIcon, ExternalIcon } from "../inbox-icons.tsx";
import BitbucketDatacenterWebhook from "./BitbucketDatacenterWebhook.tsx";
import OutcomesCard from "./OutcomesCard.tsx";
import PolicySection from "./PolicySection.tsx";
import RemoveRepository from "./RemoveRepository.tsx";
import RepoByline from "./RepoByline.tsx";
import TriageSwitch from "./TriageSwitch.tsx";

type RepoPanelProps = { repo: RepoRecord; row: RepoRow; live: boolean; stats: StatsReader | null; onClose: () => void };

/** Escape on an open tooltip closes the tooltip, not the panel. */
const KEEPS_ESCAPE = "input, textarea, select, [role=dialog], [role=menu], [data-state=delayed-open], [data-state=instant-open]";

export default function RepoPanel({ repo, row, live, stats: statsReader, onClose }: RepoPanelProps) {
  const { readOnly, snapshot } = usePortal();
  const policy = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo.name, repo.source));
  const pack = packOf(policy.data);
  const ruleOn = pack !== null && hasRuleOn(pack);
  const switching = useTriageSwitch(repo.name, repo.source, ruleOn);
  const stats = useRepoStats(statsReader, repo.name);
  const triaging = repo.enabled === true;
  const enabled = switching.isPending && switching.variables !== undefined ? switching.variables : triaging;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const instance = useBitbucketDatacenterConnection().data;
  const fromBitbucket = repo.source === "bitbucket-datacenter";
  const manualWebhook = useBitbucketDatacenterManualWebhook(repo.name, fromBitbucket && triaging);
  const [sawTriageOff, setSawTriageOff] = useState(false);
  if (!triaging && !sawTriageOff) setSawTriageOff(true);
  const locked = readOnly || snapshot?.denied.repos === true;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);

  useEffect(function closeOnEscape() {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest(KEEPS_ESCAPE)) return;
      closeRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function sourceLink() {
    if (!fromBitbucket) return <Button asChild variant="ghost" size="sm" className="gh-link"><a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer">GitHub <ExternalIcon /></a></Button>;
    if (!instance) return null;
    return <Button asChild variant="ghost" size="sm" className="gh-link"><a href={bitbucketDatacenterRepoUrl(instance.baseUrl, repo.name)} target="_blank" rel="noreferrer">Bitbucket <ExternalIcon /></a></Button>;
  }

  function renderBody() {
    if (policy.isLoading) return <div className="loading-indicator"><StatusDot label="Loading" live tone="emphasis" /></div>;
    if (policy.isError) return <div className="rs"><p role="alert" className="error">Could not load the policy. {errorText(policy.error)}</p><Button type="button" variant="outline" size="sm" onClick={() => void policy.refetch()}>Retry</Button></div>;
    return (
      <>
        <TriageSwitch repo={repo.name} enabled={enabled} triaging={triaging} disabled={locked || switching.isPending} onSwitch={switching.mutate} ruleOn={ruleOn} needsModel={pack !== null && policyNeedsModel(pack)} rerunnable={repo.source === "github"} />
        {switching.error ? <p role="alert" className="error">Could not switch triage. {errorText(switching.error)} <button type="button" className="linkish" onClick={() => switching.mutate(!triaging)}>Try again</button></p> : null}
        {manualWebhook ? <BitbucketDatacenterWebhook webhook={manualWebhook} open={sawTriageOff} /> : null}
        <PolicySection repo={repo.name} source={repo.source} pack={pack} disabled={locked} />
        {stats ? <OutcomesCard outcomes={stats.outcomes} source={repo.source} /> : null}
        <RemoveRepository repo={repo.name} source={repo.source} disabled={locked} onRemoved={onClose} />
      </>
    );
  }

  return (
    <section className="panel rp" id="rp" aria-labelledby="rp-title">
      <div className="scroll">
        <div className="pane-in">
          <header className="ph">
            <div className="crumb">
              <h2 className="title rp-t" id="rp-title" title={repo.name} tabIndex={-1} ref={headingRef}>{repo.name}</h2>
              <span className="sp" />
              {sourceLink()}
              <Button type="button" variant="ghost" size="icon" aria-label="Close repository settings" onClick={onClose}><CloseIcon /></Button>
            </div>
            {live ? <RepoByline row={row} /> : null}
          </header>
          {pack?.dropped?.length ? <p className="note">Left out because they no longer run: {pack.dropped.join("; ")}.</p> : null}
          {renderBody()}
        </div>
      </div>
    </section>
  );
}
