import { useEffect, useRef, useState } from "react";
import { Button, StatusDot } from "@corbits/react-ui";
import { VERDICTS } from "@corbits/triage-contracts";
import type { RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useRepoPack, type SaveState } from "../../lib/repo-pack.ts";
import type { RepoPackStore } from "../../lib/repo-pack-store.ts";
import { useRepoStats } from "../../lib/repo-stats.ts";
import type { RepoRow } from "../../lib/repo-rows.ts";
import { usePolicyView } from "../../lib/use-policy-view.ts";
import { CloseIcon, ExternalIcon } from "../inbox-icons.tsx";
import RepoByline from "./RepoByline.tsx";
import RulesSection from "./RulesSection.tsx";
import StepsSection from "./StepsSection.tsx";
import TriageSwitch from "./TriageSwitch.tsx";

type RepoPanelProps = { repo: RepoRecord; row: RepoRow; live: boolean; store: RepoPackStore | null; onClose: () => void };

const SAVE_WORDS: Record<SaveState, string> = { saved: "Saved", saving: "Saving…", "not-saved": "Not saved" };

/** Escape on an open tooltip closes the tooltip, not the panel. */
const KEEPS_ESCAPE = "input, textarea, select, [role=dialog], [role=menu], [data-state=delayed-open], [data-state=instant-open]";

/** A repository's triage, rules and steps in one scroll; each change saves on its own. */
export default function RepoPanel({ repo, row, live, store, onClose }: RepoPanelProps) {
  const { readOnly, snapshot } = usePortal();
  const settings = useRepoPack(store, repo.name);
  const stats = useRepoStats(store, repo.name);
  const { draft, problem } = settings;
  const view = usePolicyView(draft, settings.edit);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [closing, setClosing] = useState(false);
  const disabled = readOnly || (snapshot?.denied.repos ?? false) || settings.status !== "ready";
  const gated = !draft.policy.enabled;
  const unfinished = VERDICTS.some((verdict) => view.steps[verdict].some((step) => step.problem)) || view.rules.some((rule) => rule.problem);

  /** Unfinished steps and rules are never saved, so the first close says so and the second discards them. */
  function close() {
    if (unfinished && !closing) {
      setClosing(true);
      return;
    }
    onClose();
  }
  const closeRef = useRef(close);
  closeRef.current = close;

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

  function renderBody() {
    if (settings.status === "loading") return <div className="loading-indicator"><StatusDot label="Loading" live tone="emphasis" /></div>;
    if (settings.status === "failed") return <div className="rs"><Button type="button" variant="outline" size="sm" onClick={settings.reload}>Retry</Button></div>;
    return (
      <>
        <TriageSwitch repo={repo.name} enabled={draft.policy.enabled} triaging={settings.saved.policy.enabled} disabled={disabled} edit={settings.edit} reason={problem?.where.section === "triage" ? problem.reason : undefined} />
        <div className={gated ? "gated" : undefined} inert={gated}>
          <RulesSection draft={draft} saved={settings.saved.pack} view={view} stats={stats} disabled={disabled || gated} edit={settings.edit} problem={problem} />
          <StepsSection repo={repo.name} view={view} disabled={disabled || gated} />
        </div>
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
              <Button asChild variant="ghost" size="sm" className="gh-link"><a href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer">GitHub <ExternalIcon /></a></Button>
              <Button type="button" variant="ghost" size="icon" aria-label="Close repository settings" onClick={close}><CloseIcon /></Button>
            </div>
            {live ? <RepoByline row={row} /> : null}
          </header>
          {closing && unfinished ? <p role="alert" className="error">Unfinished steps and rules are not saved. Close again to discard them.</p> : null}
          {settings.error ? <p role="alert" className="error">{settings.error} <button type="button" className="linkish" onClick={settings.flush}>Try again</button></p> : null}
          {settings.corrupt ? <p className="note">The saved policy could not be read. The next change replaces it. {settings.corrupt}</p> : null}
          {renderBody()}
        </div>
      </div>
    </section>
  );
}
