import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Input, Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { CUSTOM_CHECK_CAP, type CheckPack, type PolicyPatchChange } from "@corbits/triage-contracts";
import { counted } from "../../lib/plural.ts";
import { FAIL_SENTENCES, absentValue, batchReady, changeSentences, codeReviewOn, judgeRuleChange, judgingOn, ruleRows, toggleCodeReview, toggleRule, withRequiredValue, type FailWord, type RuleLane, type RuleRow } from "../../lib/policy-edits.ts";

export type FilePreview = { before: string; after: string };

const LANES: Record<RuleLane, string> = { checks: "Checks", judging: "Judging" };

const FAIL_CHOICES: Array<{ word: FailWord; label: string }> = [
  { word: "fail", label: "Fail the pull request" },
  { word: "ask", label: "Ask a maintainer" },
  { word: "label", label: "Label it and leave the verdict" },
];

type PolicyEditorProps = {
  repo: string;
  pack: CheckPack;
  reviewOn: boolean;
  hasModel: boolean;
  hasPlace: boolean;
  readOnly: boolean;
  touched: readonly string[];
  applying: boolean;
  applyError: string;
  preview: (changes: readonly PolicyPatchChange[]) => Promise<FilePreview>;
  onApply: (changes: readonly PolicyPatchChange[]) => Promise<void>;
};

function passSentence(claim: string): string {
  return claim.trim() ? `It passes when it is true that ${claim.trim()}.` : "It passes when that is true.";
}

function JudgeRuleForm({ pack, changes, disabled, onAdd }: { pack: CheckPack; changes: readonly PolicyPatchChange[]; disabled: boolean; onAdd: (change: PolicyPatchChange) => void }) {
  const [step, setStep] = useState(0);
  const [claim, setClaim] = useState("");
  const [onFail, setOnFail] = useState<FailWord>("fail");
  const full = pack.custom.length + changes.filter((change) => change.kind === "add-rule").length >= CUSTOM_CHECK_CAP;
  const preview = claim.trim() ? `Is it true that ${claim.trim()}?` : "Is it true that …?";

  function add() {
    const change = judgeRuleChange(pack, changes, claim, onFail);
    if (!change) return;
    onAdd(change);
    setStep(0);
    setClaim("");
    setOnFail("fail");
  }

  if (full) return <p className="help">This repository already has {CUSTOM_CHECK_CAP} custom rules.</p>;

  return (
    <div className="judge-form">
      <p className="preview">{step < 1 ? preview : passSentence(claim)} {step > 1 ? FAIL_SENTENCES[onFail] : ""}</p>
      {step === 0 ? (
        <label className="ask">What should Triage check?
          <Input value={claim} onChange={(event) => setClaim(event.target.value)} aria-label="What should Triage check?" />
        </label>
      ) : null}
      {step === 1 ? <p className="ask">When does it pass? {passSentence(claim)}</p> : null}
      {step === 2 ? (
        <fieldset className="ask">
          <legend>What happens on fail?</legend>
          {FAIL_CHOICES.map((choice) => (
            <label key={choice.word}><input type="radio" name="on-fail" checked={onFail === choice.word} onChange={() => setOnFail(choice.word)} />{choice.label}</label>
          ))}
        </fieldset>
      ) : null}
      <div className="acts">
        {step < 2 ? <Button type="button" size="sm" disabled={disabled || !claim.trim()} onClick={() => setStep(step + 1)}>Next</Button> : <Button type="button" size="sm" disabled={disabled || !claim.trim()} onClick={add}>Add the rule</Button>}
      </div>
    </div>
  );
}

const VALUE_ASK: Record<string, string> = {
  "max-files-changed": "How many files?",
  "max-lines-changed": "How many lines?",
  "max-lines-changed-per-file": "How many lines in one file?",
  "max-additions": "How many lines added?",
  "max-deletions": "How many lines deleted?",
  "no-forbidden-paths": "Which paths?",
};

function maxOf(draft: string): number | undefined {
  const text = draft.trim();
  if (!/^[1-9]\d*$/.test(text)) return undefined;
  return Number(text);
}

function pathsOf(draft: string): string[] {
  return draft.split(/[,\n]/).map((path) => path.trim()).filter((path) => path.length > 0);
}

function ValueAsk({ id, draft, onDraft, onUse }: { id: string; draft: string; onDraft: (draft: string) => void; onUse: () => void }) {
  const kind = id === "no-forbidden-paths" ? "paths" : "max";
  const label = VALUE_ASK[id] ?? "";
  const ready = kind === "max" ? maxOf(draft) !== undefined : pathsOf(draft).length > 0;
  return (
    <div className="ask">
      <label>{label}
        <Input value={draft} aria-label={label} onChange={(event) => onDraft(event.target.value)} />
      </label>
      <Button type="button" size="sm" disabled={!ready || !label} onClick={onUse}>Use this</Button>
    </div>
  );
}
function RuleSwitch({ row, pending, expanded, asking, draft, disabled, onFlip, onDraft, onUse }: { row: RuleRow; pending: boolean; expanded: boolean; asking: boolean; draft: string; disabled: boolean; onFlip: (next: boolean) => void; onDraft: (draft: string) => void; onUse: () => void }) {
  const shown = row.on || asking;
  return (
    <div className={shown ? "rule" : "rule off"}>
      <div className="sentence">
        <span className="txt">{row.sentence}{pending ? <span className="pending-dot" title="In the open pull request" /> : null}</span>
        <Switch className="sw" checked={shown} onCheckedChange={onFlip} label={row.sentence} disabled={disabled} />
      </div>
      {expanded && asking ? <ValueAsk id={row.id} draft={draft} onDraft={onDraft} onUse={onUse} /> : null}
      {expanded && !asking ? <p className="help">{row.needsModel ? "Needs a model" : `${row.sentence}.`}{row.needsModel ? <> <a className="linkish" href="#judging-model">Add a model</a></> : null}</p> : null}
    </div>
  );
}

function Lane({ title, rows, touched, expanded, askId, draft, disabled, onFlip, onDraft, onUse }: { title: string; rows: RuleRow[]; touched: readonly string[]; expanded: string | null; askId: string | null; draft: string; disabled: boolean; onFlip: (id: string, next: boolean) => void; onDraft: (draft: string) => void; onUse: () => void }) {
  return (
    <section className="rs" aria-labelledby={`lane-${title}`}>
      <h3 id={`lane-${title}`}>{title}</h3>
      <div className="sentences">
        {rows.map((row) => (
          <RuleSwitch
            key={row.id}
            row={row}
            pending={touched.includes(row.id)}
            expanded={expanded === row.id}
            asking={askId === row.id}
            draft={draft}
            disabled={disabled}
            onFlip={(next) => onFlip(row.id, next)}
            onDraft={onDraft}
            onUse={onUse}
          />
        ))}
      </div>
    </section>
  );
}

/** The file as switches. Changes collect in the tray and leave as one pull request. */
export function PolicyEditor({ repo, pack, reviewOn, hasModel, hasPlace, readOnly, touched, applying, applyError, preview, onApply }: PolicyEditorProps) {
  const [changes, setChanges] = useState<PolicyPatchChange[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [askId, setAskId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const rows = ruleRows(pack, changes, hasModel);
  const review = codeReviewOn(reviewOn, changes);
  const on = rows.checks.filter((row) => row.on).length + rows.judging.filter((row) => row.on).length;
  const ready = batchReady(pack, changes);
  const shown = useQuery({
    queryKey: ["policy-patch-preview", repo, changes],
    queryFn: function loadPreview() {
      return preview(changes);
    },
    enabled: changes.length > 0 && ready,
    retry: false,
  });

  function flipRule(id: string, next: boolean) {
    setExpanded(id);
    if (next && absentValue(pack, id) !== undefined) {
      setAskId(id);
      setDraft("");
      setChanges((current) => toggleRule(pack, current, id, false));
      return;
    }
    setAskId(null);
    setChanges((current) => toggleRule(pack, current, id, next));
  }

  function useValue() {
    if (askId === null) return;
    const field = absentValue(pack, askId);
    if (field === "max") {
      const max = maxOf(draft);
      if (max === undefined) return;
      setChanges((current) => withRequiredValue(current, askId, { max }));
    } else if (field === "paths") {
      const paths = pathsOf(draft);
      if (paths.length === 0) return;
      setChanges((current) => withRequiredValue(current, askId, { paths }));
    } else {
      return;
    }
    setAskId(null);
    setDraft("");
  }

  function flipReview(next: boolean) {
    setExpanded("code-review");
    setChanges((current) => toggleCodeReview(reviewOn, current, next));
  }

  function addRule(change: PolicyPatchChange) {
    setChanges((current) => [...current, change]);
  }

  async function open() {
    await onApply(changes);
    setChanges([]);
  }

  const sentences = changeSentences(pack, changes);

  return (
    <div>
      <p className="lede">{counted(on, "rule", "rules")} on. Judging is {judgingOn(rows.judging) ? "on" : "off"}. Code review is {review ? "on" : "off"}.</p>
      {(Object.keys(LANES) as RuleLane[]).map((lane) => <Lane key={lane} title={LANES[lane]} rows={rows[lane]} touched={touched} expanded={expanded} askId={askId} draft={draft} disabled={readOnly} onFlip={flipRule} onDraft={setDraft} onUse={useValue} />)}
      <section className="rs" aria-labelledby="lane-code-review">
        <h3 id="lane-code-review">Code review</h3>
        <div className={review ? "rule" : "rule off"}>
          <div className="sentence">
            <span className="txt">Read each pull request for bugs{touched.includes("code-review") ? <span className="pending-dot" title="In the open pull request" /> : null}</span>
            <Switch className="sw" checked={review} onCheckedChange={flipReview} label="Read each pull request for bugs" disabled={readOnly} />
          </div>
          {expanded === "code-review" ? (
            <p className="help">{hasPlace ? "Triage reads each new commit for bugs." : "Code review needs an isolated place to run."}{hasPlace ? null : <> <a className="linkish" href="#code-review-places">Set one up</a></>}</p>
          ) : null}
        </div>
      </section>
      <section className="rs" aria-labelledby="lane-new-rule">
        <h3 id="lane-new-rule">New judge rule</h3>
        <JudgeRuleForm pack={pack} changes={changes} disabled={readOnly} onAdd={addRule} />
      </section>
      {changes.length > 0 && ready ? (
        <aside className="tray" aria-live="polite">
          <p><b>{counted(changes.length, "change", "changes")}.</b> Open a pull request to apply them.</p>
          <ul>{sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
          {shown.data ? (
            <div className="file-pair">
              <div><span>Before</span><pre className="file-text">{shown.data.before}</pre></div>
              <div><span>After</span><pre className="file-text">{shown.data.after}</pre></div>
            </div>
          ) : null}
          {shown.isError ? <p role="alert" className="error">{errorText(shown.error)}</p> : null}
          {applyError ? <p role="alert" className="error">{applyError}</p> : null}
          <Button type="button" disabled={readOnly || applying || shown.isLoading || shown.isError} onClick={() => void open()}>Open a pull request</Button>
        </aside>
      ) : null}
    </div>
  );
}
