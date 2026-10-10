import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Switch } from "@corbits/react-ui";
import { CUSTOM_CHECK_CAP, type CleanupMode } from "@corbits/triage-contracts";
import {
  CHECK_GROUPS,
  checkValue,
  hasCheck,
  isCheckOn,
  specOf,
  withCheckValue,
  withChecksEnabled,
  withCustomCheck,
  withCustomInstruction,
  withoutCustomCheck,
  type CheckGroupId,
  type DraftPack,
} from "../lib/check-catalog.ts";
import type { RepoRecord } from "../lib/hub-api.ts";
import { usePortal } from "../lib/portal.tsx";
import { catalogChecksOn, recommendedDraft } from "../lib/repo-draft.ts";
import { useRepoSettings } from "../lib/repo-settings.ts";
import type { RepoHealth, RepoRow } from "../lib/repo-rows.ts";
import { relativeTime } from "../lib/triage-view.ts";
import { CloseIcon, ExternalIcon } from "./inbox-icons.tsx";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function HealthMark({ health }: { health: RepoHealth }) {
  const mark = health.tone === "ok"
    ? <span className="dot ready" />
    : health.tone === "warn" ? <span className="mk flag">!</span> : <span className="dot hollow" />;
  return <span className={`hl ${health.tone}`}>{mark}{health.label}</span>;
}

type SentenceProps = { label: string; on: boolean; onChange: (on: boolean) => void; model?: boolean; disabled: boolean; children: ReactNode };

function Sentence({ label, on, onChange, model, disabled, children }: SentenceProps) {
  return (
    <div className="sentence">
      <span className="txt">{children}</span>
      {model ? <span className="model">Decision model</span> : null}
      <Switch className="sw" checked={on} onCheckedChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}

type ValueProps = { pack: DraftPack; id: string; label: string; disabled: boolean; onChange: (value: string | number) => void };

function NumberValue({ pack, id, label, disabled, onChange }: ValueProps) {
  const spec = specOf(id);
  return <input className="val" type="number" min={spec?.min ?? 0} step={1} aria-label={label} disabled={disabled} value={Number(checkValue(pack, id))} onChange={(event) => onChange(Number(event.target.value))} />;
}

function SelectValue({ pack, id, label, disabled, onChange }: ValueProps) {
  const spec = specOf(id);
  return (
    <select className="val" aria-label={label} disabled={disabled} value={String(checkValue(pack, id))} onChange={(event) => onChange(event.target.value)}>
      {(spec?.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

function TextValue({ pack, id, label, disabled, onChange }: ValueProps) {
  return <input className="val w" aria-label={label} disabled={disabled} value={String(checkValue(pack, id) ?? "")} onChange={(event) => onChange(event.target.value)} />;
}

type GlobsProps = { globs: string[]; disabled: boolean; onChange: (globs: string[]) => void };

function Globs({ globs, disabled, onChange }: GlobsProps) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const addRef = useRef<HTMLButtonElement>(null);
  /** Set when the focused control is about to disappear, so focus lands on Add path rather than the page. */
  const refocus = useRef(false);

  useEffect(function returnFocusToAdd() {
    if (adding || !refocus.current) return;
    refocus.current = false;
    addRef.current?.focus();
  });

  function remove(glob: string) {
    refocus.current = true;
    onChange(globs.filter((item) => item !== glob));
  }

  function commit() {
    const glob = text.trim();
    if (glob && !globs.includes(glob)) onChange([...globs, glob]);
    setText("");
    setAdding(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      refocus.current = true;
      commit();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      refocus.current = true;
      setText("");
      setAdding(false);
    }
  }

  return (
    <>
      {globs.map((glob) => (
        <span key={glob} className="glob">{glob}<button type="button" aria-label={`Remove ${glob}`} disabled={disabled} onClick={() => remove(glob)}>×</button></span>
      ))}
      {adding
        ? <input className="val w mono-val" aria-label="Path to add" placeholder="path/**" autoFocus value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} onBlur={commit} />
        : <button type="button" className="linkish" ref={addRef} disabled={disabled} onClick={() => setAdding(true)}>Add path</button>}
    </>
  );
}

type CustomFormProps = { onAdd: (check: { name: string; group: CheckGroupId; instruction: string }) => void; onCancel: () => void };

function CustomCheckForm({ onAdd, onCancel }: CustomFormProps) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState<CheckGroupId>("pr");
  const [instruction, setInstruction] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !instruction.trim()) return;
    onAdd({ name: name.trim(), group, instruction: instruction.trim() });
  }

  return (
    <form className="own-form" onSubmit={submit} aria-label="Add a check">
      <label>Name<input className="val w" required maxLength={80} autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Where it looks
        <select className="val" value={group} onChange={(event) => setGroup(event.target.value as CheckGroupId)}>
          {CHECK_GROUPS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label className="wide">What to check<input className="val w" required placeholder="Flag changes to public API responses and ask me" value={instruction} onChange={(event) => setInstruction(event.target.value)} /></label>
      <div className="own-acts">
        <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-sm">Add check</button>
      </div>
    </form>
  );
}

function Byline({ row }: { row: RepoRow }) {
  if ("error" in row.pulls) return <div className="byline"><span title={row.pulls.error}>Could not read pull requests from GitHub</span></div>;
  const { open, needsYou, lastActivity } = row.pulls;
  return (
    <div className="byline">
      <span>{open} open</span>
      <span>{needsYou} need you</span>
      <span>{lastActivity ? `last activity ${relativeTime(lastActivity)}` : "no activity yet"}</span>
      {row.health.tone === "warn" ? null : <span><HealthMark health={row.health} /></span>}
    </div>
  );
}

type RepoPanelProps = { repo: RepoRecord; row: RepoRow; live: boolean; onClose: () => void };

export default function RepoPanel({ repo, row, live, onClose }: RepoPanelProps) {
  const { readOnly, snapshot, runBacklog } = usePortal();
  const settings = useRepoSettings(repo);
  const { draft, saved } = settings;
  const pack = draft.pack;
  const [adding, setAdding] = useState(false);
  const [rerunError, setRerunError] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const locked = readOnly || (snapshot?.denied.repos ?? false) || settings.status !== "ready" || settings.saving;
  const checksOn = catalogChecksOn(pack);
  const addCheckRef = useRef<HTMLButtonElement>(null);
  /** Set when the focused control is about to disappear, so focus lands on Add a check rather than the page. */
  const refocusAdd = useRef(false);

  useEffect(function returnFocusToAddCheck() {
    if (adding || !refocusAdd.current) return;
    refocusAdd.current = false;
    addCheckRef.current?.focus();
  });

  useEffect(function focusHeading() {
    headingRef.current?.focus();
  }, []);

  useEffect(function closeOnEscape() {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select")) return;
      onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function editPack(update: (current: DraftPack) => DraftPack) {
    settings.edit((current) => ({ ...current, pack: update(current.pack) }));
  }

  function toggle(ids: string[]) {
    return function setOn(on: boolean) {
      editPack((current) => withChecksEnabled(current, saved.pack, ids, on));
    };
  }

  function value(id: string, key: string) {
    return function setValue(next: string | number | string[]) {
      editPack((current) => withCheckValue(current, saved.pack, id, key, next));
    };
  }

  function addCustom(check: { name: string; group: CheckGroupId; instruction: string }) {
    editPack((current) => withCustomCheck(current, check));
    closeCustomForm();
  }

  function closeCustomForm() {
    refocusAdd.current = true;
    setAdding(false);
  }

  function removeCustom(id: string) {
    refocusAdd.current = true;
    editPack((current) => withoutCustomCheck(current, id));
  }

  /** The bar goes away once nothing is left to save, so focus returns to the panel heading. */
  async function save() {
    await settings.save();
    if (!document.activeElement || document.activeElement === document.body) headingRef.current?.focus();
  }

  function discard() {
    settings.discard();
    headingRef.current?.focus();
  }

  function setMode(mode: CleanupMode) {
    editPack((current) => ({ ...current, mode }));
  }

  async function triageAgain() {
    setRerunError("");
    try {
      await runBacklog(repo.name, "Triaging open pull requests again.");
    } catch (cause) {
      setRerunError(`Could not triage again. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const sizeParts = hasCheck(pack, "files") || !hasCheck(pack, "size") ? ["files"] : [];
  if (hasCheck(pack, "size") || !hasCheck(pack, "files")) sizeParts.push("size");
  const globs = checkValue(pack, "paths");

  function renderBody() {
    if (settings.status === "loading") return <p className="note" role="status">Loading settings…</p>;
    if (settings.status === "failed") {
      return <div className="rs"><button type="button" className="btn btn-sm" onClick={settings.reload}>Retry</button></div>;
    }
    return (
      <>
        {settings.needsSetup ? (
          <div className="route warn">
            <span className="mk flag">!</span>
            <div className="route-t">
              <b>{settings.corrupt ? "Checks unreadable" : "Needs setup"}</b>
              <span>{settings.corrupt ? "The saved checks could not be read. Saving replaces them." : "Triage has no checks for this repository yet. Start from the recommended ones, or switch on the checks you want, then save."}</span>
            </div>
            <button type="button" className="btn btn-sm" disabled={locked} onClick={() => editPack(recommendedDraft)}>Use recommended</button>
          </div>
        ) : null}

        <section className="rs" aria-labelledby="rs-posting">
          <h3 id="rs-posting">Posting</h3>
          <div className="radio-cards" role="radiogroup" aria-labelledby="rs-posting">
            <label className={pack.mode === "human-approved" ? "on" : undefined}>
              <input className="sr-only" type="radio" name="posting" checked={pack.mode === "human-approved"} disabled={locked} onChange={() => setMode("human-approved")} />
              <span className="rdot" />
              <span><b>Ask me before posting</b> You approve each reply and label.</span>
            </label>
            <label className={pack.mode === "automated" ? "on" : undefined}>
              <input className="sr-only" type="radio" name="posting" checked={pack.mode === "automated"} disabled={locked} onChange={() => setMode("automated")} />
              <span className="rdot" />
              <span><b>Post automatically</b> Labels and one reply. Never merges or closes.</span>
            </label>
          </div>
        </section>

        <section className="rs" aria-labelledby="rs-triage">
          <h3 id="rs-triage">Triage</h3>
          <p>
            {saved.enabled
              ? <>Triage reads each pull request as it opens or changes. <button type="button" className="linkish" disabled={locked} onClick={() => void triageAgain()}>Triage open pull requests again</button></>
              : "Nothing runs until triage is on."}
          </p>
          {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
          <div className="sentences">
            <Sentence label="Triage pull requests in this repository" on={draft.enabled} disabled={locked} onChange={(enabled) => settings.edit((current) => ({ ...current, enabled }))}>
              Triage pull requests in this repository
            </Sentence>
            <Sentence label="Triage pull requests while they are drafts" on={draft.triageDrafts} disabled={locked} onChange={(triageDrafts) => settings.edit((current) => ({ ...current, triageDrafts }))}>
              Triage pull requests while they are drafts
              <small>Drafts are never shown as ready. Off, they wait until marked ready.</small>
            </Sentence>
          </div>
        </section>

        <section className="rs" aria-labelledby="rs-checks">
          <h3 id="rs-checks">Checks {checksOn === null ? null : <span className="n">{checksOn} on</span>}</h3>
          <p>The rules Triage applies to every pull request. <button type="button" className="linkish" disabled={locked} onClick={() => editPack(recommendedDraft)}>Reset to recommended</button></p>
          <div className="sentences">
            <Sentence label="Flag draft pull requests" on={isCheckOn(pack, "draft")} disabled={locked} onChange={toggle(["draft"])}>
              Flag pull requests that are still drafts
            </Sentence>
            <Sentence label="Flag large pull requests" on={isCheckOn(pack, "files") || isCheckOn(pack, "size")} disabled={locked} onChange={toggle(sizeParts)}>
              Flag pull requests larger than
              {sizeParts.includes("files") ? <span className="vu"><NumberValue pack={pack} id="files" label="Most files" disabled={locked} onChange={value("files", "maxFiles")} />{sizeParts.length === 2 ? "files or" : "files"}</span> : null}
              {sizeParts.includes("size") ? <span className="vu"><NumberValue pack={pack} id="size" label="Most lines" disabled={locked} onChange={value("size", "maxLines")} />lines</span> : null}
            </Sentence>
            <Sentence label="Spot duplicates" on={isCheckOn(pack, "duplicate")} disabled={locked} onChange={toggle(["duplicate"])}>
              Spot duplicates of earlier open pull requests
            </Sentence>
            <Sentence label="Require a linked issue" on={isCheckOn(pack, "issue")} disabled={locked} onChange={toggle(["issue"])}>
              Require a linked issue in <SelectValue pack={pack} id="issue" label="Issue tracker" disabled={locked} onChange={value("issue", "tracker")} />
            </Sentence>
            <Sentence label="Require a label on the linked issue" on={isCheckOn(pack, "issueLabel")} disabled={locked || !isCheckOn(pack, "issue")} onChange={toggle(["issueLabel"])}>
              Require the linked issue to have the label <TextValue pack={pack} id="issueLabel" label="Issue label" disabled={locked || !isCheckOn(pack, "issue")} onChange={value("issueLabel", "label")} />
            </Sentence>
            <Sentence label="Flag unreviewed pull requests" on={isCheckOn(pack, "reviewers")} disabled={locked} onChange={toggle(["reviewers"])}>
              Flag when no reviewers are requested and nobody has approved
            </Sentence>
            <Sentence label="Flag base drift" on={isCheckOn(pack, "drift")} disabled={locked} onChange={toggle(["drift"])}>
              Flag when <NumberValue pack={pack} id="drift" label="Commits behind" disabled={locked} onChange={value("drift", "maxCommits")} /> or more commits behind the base branch
            </Sentence>
            <Sentence label="Flag merge conflicts" on={isCheckOn(pack, "conflicts")} disabled={locked} onChange={toggle(["conflicts"])}>
              Flag merge conflicts with the base branch
            </Sentence>
            <Sentence label="Require GitHub checks to pass" on={isCheckOn(pack, "ci")} disabled={locked} onChange={toggle(["ci"])}>
              Require GitHub's required checks to pass
            </Sentence>
            <Sentence label="Forbid paths" on={isCheckOn(pack, "paths")} disabled={locked} onChange={toggle(["paths"])}>
              Never accept changes to <Globs globs={Array.isArray(globs) ? globs : []} disabled={locked} onChange={value("paths", "globs")} />
            </Sentence>
            <Sentence label="Check the change is focused" model on={isCheckOn(pack, "focused")} disabled={locked} onChange={toggle(["focused"])}>
              Check the change is focused on one thing
            </Sentence>
            <Sentence label="Check tests are added" model on={isCheckOn(pack, "tests")} disabled={locked} onChange={toggle(["tests"])}>
              Check tests are added when behaviour changes
            </Sentence>
            <Sentence label="Check docs are updated" model on={isCheckOn(pack, "docs")} disabled={locked} onChange={toggle(["docs"])}>
              Check docs are updated when behaviour changes
            </Sentence>
          </div>
        </section>

        <section className="rs" aria-labelledby="rs-own">
          <h3 id="rs-own">Your own checks</h3>
          <p>Plain sentences, up to {CUSTOM_CHECK_CAP}.</p>
          <div className="sentences">
            {pack.custom.map((check) => (
              <div className="sentence own" key={check.id}>
                {check.typed ? (
                  <span className="txt"><b>{check.name}</b></span>
                ) : (
                  <label className="txt"><b>{check.name}</b>
                    <input className="val w" aria-label={`What ${check.name} checks`} aria-invalid={!(check.instruction ?? "").trim()} disabled={locked} value={check.instruction ?? ""} onChange={(event) => editPack((current) => withCustomInstruction(current, check.id, event.target.value))} />
                  </label>
                )}
                <span className="model">{check.typed?.kind === "rule" ? "Rule" : "Decision model"}</span>
                <button type="button" className="btn btn-quiet btn-sm icon" aria-label={`Remove ${check.name}`} disabled={locked} onClick={() => removeCustom(check.id)}><CloseIcon /></button>
              </div>
            ))}
            {adding ? (
              <CustomCheckForm onCancel={closeCustomForm} onAdd={addCustom} />
            ) : (
              <div className="sentence">
                <button type="button" className="btn btn-sm" ref={addCheckRef} disabled={locked || pack.custom.length >= CUSTOM_CHECK_CAP} onClick={() => setAdding(true)}>Add a check</button>
              </div>
            )}
          </div>
        </section>
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
            {live ? <Byline row={row} /> : null}
          </header>
          {settings.error ? <p role="alert" className="error">{settings.error}</p> : null}
          {settings.stale ? <p className="note"><button type="button" className="linkish" onClick={settings.reload}>Reload</button> Reloading discards your edits.</p> : null}
          {renderBody()}
        </div>
      </div>
      {settings.changes > 0 || settings.unlinked ? (
        <div className="bar save" role="region" aria-label="Unsaved changes">
          <span className={settings.blocked ? "blocked" : undefined}>{settings.blocked ?? (settings.changes > 0 ? plural(settings.changes, "unsaved change") : "Checks saved but not linked yet")}</span>
          <span className="sp" />
          {settings.changes > 0 ? <button type="button" className="btn btn-quiet btn-sm" disabled={settings.saving} onClick={discard}>Discard</button> : null}
          <button type="button" className="btn btn-primary btn-sm" disabled={locked || settings.stale || settings.blocked !== null} onClick={() => void save()}>{settings.saving ? "Saving…" : "Save changes"}</button>
        </div>
      ) : null}
    </section>
  );
}
