import { useEffect, useRef, useState } from "react";
import { Button, StatusDot } from "@corbits/react-ui";
import { bitbucketDatacenterRepoUrl, useBitbucketDatacenterConnection, useBitbucketDatacenterManualWebhook } from "../../lib/bitbucket-datacenter.ts";
import type { RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useRepoPack, type SaveState } from "../../lib/repo-pack.ts";
import type { RepoPackStore } from "../../lib/repo-pack-store.ts";
import { useRepoStats } from "../../lib/repo-stats.ts";
import type { RepoRow } from "../../lib/repo-rows.ts";
import { CloseIcon, ExternalIcon } from "../inbox-icons.tsx";
import { hasRuleOn } from "../../lib/pack-draft.ts";
import BitbucketDatacenterWebhook from "./BitbucketDatacenterWebhook.tsx";
import OutcomesCard from "./OutcomesCard.tsx";
import PolicyGrants from "./PolicyGrants.tsx";
import PolicySection from "./PolicySection.tsx";
import RemoveRepository from "./RemoveRepository.tsx";
import RepoByline from "./RepoByline.tsx";
import TriageSwitch from "./TriageSwitch.tsx";

type RepoPanelProps = { repo: RepoRecord; row: RepoRow; live: boolean; store: RepoPackStore | null; onClose: () => void };

const SAVE_WORDS: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", "not-saved": "Not saved" };

/** Escape on an open tooltip closes the tooltip, not the panel. */
const KEEPS_ESCAPE = "input, textarea, select, [role=dialog], [role=menu], [data-state=delayed-open], [data-state=instant-open]";

export default function RepoPanel({ repo, row, live, store, onClose }: RepoPanelProps) {
  const { readOnly, snapshot } = usePortal();
  const settings = useRepoPack(store, repo.name, repo.source);
  const stats = useRepoStats(store, repo.name);
  const { draft } = settings;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const instance = useBitbucketDatacenterConnection().data;
  const fromBitbucket = repo.source === "bitbucket-datacenter";
  const manualWebhook = useBitbucketDatacenterManualWebhook(repo.name, fromBitbucket && settings.saved.policy.enabled);
  const [sawTriageOff, setSawTriageOff] = useState(false);
  if (settings.status === "ready" && !settings.saved.policy.enabled && !sawTriageOff) setSawTriageOff(true);
  const disabled = readOnly || snapshot?.denied.repos === true || settings.status !== "ready";
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
    if (settings.status === "loading") return <div className="loading-indicator"><StatusDot label="Loading" live tone="emphasis" /></div>;
    if (settings.status === "failed") return <div className="rs"><Button type="button" variant="outline" size="sm" onClick={settings.reload}>Retry</Button></div>;
    return (
      <>
        <TriageSwitch repo={repo.name} enabled={draft.policy.enabled} triaging={settings.saved.policy.enabled} disabled={disabled} edit={settings.edit} ruleOn={hasRuleOn(draft.pack)} rerunnable={repo.source === "github"} />
        {manualWebhook ? <BitbucketDatacenterWebhook webhook={manualWebhook} open={sawTriageOff} /> : null}
        <div className={settings.saved.policy.enabled ? undefined : "gated"} inert={!settings.saved.policy.enabled}><PolicyGrants repo={repo.name} source={repo.source} disabled={disabled} /></div>
        <PolicySection repo={repo.name} source={repo.source} pack={settings.saved.pack} disabled={readOnly || snapshot?.denied.repos === true} onSettled={settings.reload} />
        {stats ? <OutcomesCard outcomes={stats.outcomes} source={repo.source} /> : null}
        <RemoveRepository repo={repo.name} source={repo.source} disabled={readOnly || snapshot?.denied.repos === true} onRemoved={onClose} />
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
              {settings.status === "ready" ? <span className={`saved ${settings.save}`} role="status" aria-live="polite">{SAVE_WORDS[settings.save]}</span> : null}
              <span className="sp" />
              {sourceLink()}
              <Button type="button" variant="ghost" size="icon" aria-label="Close repository settings" onClick={onClose}><CloseIcon /></Button>
            </div>
            {live ? <RepoByline row={row} /> : null}
          </header>
          {settings.conflicts.length ? <p className="note">Another writer also changed {settings.conflicts.join(", ")}; yours was kept.</p> : null}
          {settings.error ? <p role="alert" className="error">{settings.error} <button type="button" className="linkish" onClick={settings.flush}>Try again</button></p> : null}
          {settings.saved.pack.dropped?.length ? <p className="note">Left out because they no longer run: {settings.saved.pack.dropped.join("; ")}.</p> : null}
          {settings.corrupt ? <p className="note">The saved policy could not be read. The next change replaces it. {settings.corrupt}</p> : null}
          {renderBody()}
        </div>
      </div>
    </section>
  );
}
