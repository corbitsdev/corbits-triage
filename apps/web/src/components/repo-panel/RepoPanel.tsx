import { useEffect, useRef } from "react";
import { StatusDot } from "@corbits/react-ui";
import type { RepoRecord } from "../../lib/hub-api.ts";
import type { DraftProblem } from "../../lib/pack-draft.ts";
import { usePortal } from "../../lib/portal.tsx";
import { useRepoPack } from "../../lib/repo-pack.ts";
import type { RepoPackStore } from "../../lib/repo-pack-store.ts";
import type { RepoRow } from "../../lib/repo-rows.ts";
import { CloseIcon, ExternalIcon } from "../inbox-icons.tsx";
import ActionsList from "./ActionsList.tsx";
import PostingToggle from "./PostingToggle.tsx";
import PreviewRow from "./PreviewRow.tsx";
import RepoFacts from "./RepoFacts.tsx";
import RolesEditor from "./RolesEditor.tsx";
import SaveBar from "./SaveBar.tsx";

type RepoPanelProps = { repo: RepoRecord; row: RepoRow; live: boolean; store: RepoPackStore | null; onClose: () => void };

function anchorOf(problem: DraftProblem): string {
  switch (problem.where.section) {
    case "actions":
      return `rp-action-${problem.where.id}`;
    case "triage":
      return "rp-triage";
    default:
      return "rp-verdict";
  }
}

/** A repository's facts, posting, roles and actions, edited as one draft and saved through the store. */
export default function RepoPanel({ repo, row, live, store, onClose }: RepoPanelProps) {
  const { readOnly, snapshot } = usePortal();
  const settings = useRepoPack(store, repo.name);
  const { draft, problem } = settings;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const disabled = readOnly || (snapshot?.denied.repos ?? false) || settings.status !== "ready" || settings.saving;

  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);

  useEffect(function closeOnEscape() {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [role=dialog], [role=menu]")) return;
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** The bar goes away once nothing is left to save, so focus returns to the panel heading. */
  async function save() {
    await settings.save();
    if (!document.activeElement || document.activeElement === document.body) headingRef.current?.focus();
  }

  function discard() {
    settings.discard();
    headingRef.current?.focus();
  }

  function show(found: DraftProblem) {
    document.getElementById(anchorOf(found))?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function renderBody() {
    if (settings.status === "loading") return <div className="loading-indicator"><StatusDot label="Loading" live tone="emphasis" /></div>;
    if (settings.status === "failed") return <div className="rs"><button type="button" className="btn btn-sm" onClick={settings.reload}>Retry</button></div>;
    const where = problem?.where;
    return (
      <>
        <RepoFacts repo={repo.name} row={row} live={live} policy={draft.policy} triaging={settings.saved.policy.enabled} disabled={disabled} edit={settings.edit} reason={where?.section === "triage" ? problem?.reason : undefined} />
        <PostingToggle mode={draft.policy.cleanupMode} disabled={disabled} onChange={(cleanupMode) => settings.edit((current) => ({ ...current, policy: { ...current.policy, cleanupMode } }))} />
        <RolesEditor roles={draft.policy.roles} actions={draft.pack.actions} disabled={disabled} edit={settings.edit} />
        <ActionsList draft={draft} saved={settings.saved.pack} disabled={disabled} edit={settings.edit} problem={problem} />
        <PreviewRow repo={repo.name} draft={draft} />
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
              <a className="btn btn-quiet btn-sm" href={`https://github.com/${repo.name}`} target="_blank" rel="noreferrer">GitHub <ExternalIcon /></a>
              <button type="button" className="btn btn-quiet btn-sm icon" aria-label="Close repository settings" onClick={onClose}><CloseIcon /></button>
            </div>
          </header>
          {settings.error ? <p role="alert" className="error">{settings.error}</p> : null}
          {settings.stale ? <p className="note"><button type="button" className="linkish" onClick={settings.reload}>Reload</button> Reloading discards your edits.</p> : null}
          {settings.corrupt ? <p className="note">The saved checks could not be read. Saving replaces them. {settings.corrupt}</p> : null}
          {renderBody()}
        </div>
      </div>
      <SaveBar changes={settings.changes} unlinked={settings.unlinked} corrupt={settings.corrupt !== null} problem={problem} saving={settings.saving} disabled={disabled || settings.stale} onShow={show} onDiscard={discard} onSave={() => void save()} />
    </section>
  );
}
