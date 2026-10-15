import { Button, Checkbox, Input, Select, Textarea } from "@corbits/react-ui";
import { DEFAULT_SCORE_LEVELS, ISSUE_TRACKER_NAMES, ISSUE_TRACKERS, recommendedPack, type CatalogCheck, type CatalogId, type CheckPack, type IssueTracker, type ModelShape } from "@corbits/triage-contracts";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { withCatalogParams, withCustomCheck, type CustomForm } from "../pack-edit.ts";

export const EDITABLE_CATALOG: readonly CatalogId[] = ["max-files-changed", "max-lines-changed", "no-forbidden-paths", "linked-issue"];

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function wholeNumber(text: string, min: number, what: string): number | string {
  const value = Number(text);
  if (text.trim() === "" || !Number.isInteger(value) || value < min) return `${what} must be a whole number from ${min} up.`;
  return value;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string, hintId: string | undefined) => ReactNode }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {hint ? <p className="hint" id={hintId}>{hint}</p> : null}
    </div>
  );
}

/** An editor opens where its button was, so focus moves to its first field. */
function useFirstFieldFocus(): RefObject<HTMLFormElement | null> {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(function focusFirstField() {
    ref.current?.querySelector<HTMLElement>("input, select, textarea")?.focus();
  }, []);
  return ref;
}

function EditorFoot({ error, saveLabel, onCancel }: { error: string | null; saveLabel: string; onCancel: () => void }) {
  return (
    <>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="row">
        <Button type="submit" size="sm" variant="outline">{saveLabel}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </>
  );
}

type CatalogEditorProps = { id: CatalogId; pack: CheckPack; onSave: (pack: CheckPack) => Promise<void>; onCancel: () => void };

export function CatalogEditor({ id, pack, onSave, onCancel }: CatalogEditorProps) {
  const row: CatalogCheck = { ...recommendedPack(pack.repo).checks[id], ...pack.checks[id], enabled: pack.checks[id]?.enabled ?? false };
  const [maxFiles, setMaxFiles] = useState(String(row.maxFiles ?? ""));
  const [maxLines, setMaxLines] = useState(String(row.maxLines ?? ""));
  const [globs, setGlobs] = useState((row.forbiddenGlobs ?? []).join("\n"));
  const [tracker, setTracker] = useState<IssueTracker>(row.tracker ?? "either");
  const [error, setError] = useState<string | null>(null);
  const formRef = useFirstFieldFocus();

  function params(): Partial<CatalogCheck> | string {
    switch (id) {
      case "max-files-changed": {
        const files = wholeNumber(maxFiles, 1, "Files");
        return typeof files === "string" ? files : { maxFiles: files };
      }
      case "max-lines-changed": {
        const lines = wholeNumber(maxLines, 1, "Lines");
        return typeof lines === "string" ? lines : { maxLines: lines };
      }
      case "no-forbidden-paths": {
        const list = linesOf(globs);
        return list.length ? { forbiddenGlobs: list } : "List at least one path.";
      }
      case "linked-issue":
        return { tracker };
      default:
        return {};
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const next = params();
    if (typeof next === "string") return setError(next);
    const changed = withCatalogParams(pack, id, next);
    if ("reason" in changed) return setError(changed.reason);
    setError(null);
    await onSave(changed);
  }

  return (
    <form className="editor" ref={formRef} onSubmit={save} aria-label="Check limits">
      {id === "max-files-changed" ? (
        <Field label="Most files">{(fid) => <Input id={fid} className="mono" inputMode="numeric" value={maxFiles} onChange={(event) => setMaxFiles(event.target.value)} />}</Field>
      ) : null}
      {id === "max-lines-changed" ? (
        <Field label="Most changed lines">{(fid) => <Input id={fid} className="mono" inputMode="numeric" value={maxLines} onChange={(event) => setMaxLines(event.target.value)} />}</Field>
      ) : null}
      {id === "no-forbidden-paths" ? (
        <Field label="Paths that must not change" hint="One per line. * matches within a folder, ** across folders.">
          {(fid, hid) => <Textarea id={fid} aria-describedby={hid} className="mono" rows={3} value={globs} onChange={(event) => setGlobs(event.target.value)} />}
        </Field>
      ) : null}
      {id === "linked-issue" ? (
        <Field label="Issue tracker">
          {(fid) => (
            <Select id={fid} value={tracker} onChange={(event) => setTracker(event.target.value as IssueTracker)}>
              {ISSUE_TRACKERS.map((each) => <option key={each} value={each}>{ISSUE_TRACKER_NAMES[each]}</option>)}
            </Select>
          )}
        </Field>
      ) : null}
      <EditorFoot error={error} saveLabel="Save limits" onCancel={onCancel} />
    </form>
  );
}

/** The editor's text for each of a check's parameters, so switching nothing loses what was typed. */
type CustomText = { name: string; claim: string; subject: string; levels: string; failBelow: string; options: string; failOn: string[] };

function textOf(form: CustomForm | undefined, name: string): CustomText {
  const text: CustomText = { name, claim: "", subject: "", levels: DEFAULT_SCORE_LEVELS.join("\n"), failBelow: "", options: "", failOn: [] };
  if (!form) return text;
  const named = { ...text, name: form.name };
  switch (form.shape) {
    case "is-true": return { ...named, claim: form.claim };
    case "score": return { ...named, subject: form.subject, levels: form.levels.join("\n"), failBelow: form.failBelow ?? "" };
    case "choose": return { ...named, options: form.options.join("\n"), failOn: form.failOn };
  }
}

function formOf(shape: ModelShape, text: CustomText): CustomForm | string {
  const name = text.name.trim();
  if (!name) return "Give the rule a name.";
  const kind = "model";
  switch (shape) {
    case "is-true": return { name, kind, shape, claim: text.claim.trim() };
    case "score": {
      const failBelow = text.failBelow.trim();
      return { name, kind, shape, subject: text.subject.trim(), levels: linesOf(text.levels), ...(failBelow && { failBelow }) };
    }
    case "choose": {
      const options = linesOf(text.options);
      return { name, kind, shape, options, failOn: text.failOn.filter((option) => options.includes(option)) };
    }
  }
}

type CustomEditorProps = {
  shape: ModelShape;
  pack: CheckPack;
  id?: string;
  form?: CustomForm;
  defaultName: string;
  onSave: (pack: CheckPack, id: string) => Promise<void>;
  onCancel: () => void;
};

export function CustomEditor({ shape, pack, id, form, defaultName, onSave, onCancel }: CustomEditorProps) {
  const [text, setText] = useState(() => textOf(form, defaultName));
  const [error, setError] = useState<string | null>(null);
  const formRef = useFirstFieldFocus();

  function set(key: Exclude<keyof CustomText, "failOn">) {
    return function onChange(event: { target: { value: string } }) {
      setText({ ...text, [key]: event.target.value });
    };
  }

  function failOn(option: string) {
    return function onCheckedChange(checked: boolean) {
      setText({ ...text, failOn: checked ? [...text.failOn, option] : text.failOn.filter((each) => each !== option) });
    };
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    const next = formOf(shape, text);
    if (typeof next === "string") return setError(next);
    const changed = withCustomCheck(pack, next, id);
    if ("reason" in changed) return setError(changed.reason.replace(/^Custom rule \S+ /, ""));
    setError(null);
    await onSave(changed.pack, changed.id);
  }

  return (
    <form className="editor" ref={formRef} onSubmit={save} aria-label={id ? "Edit rule" : "New rule"}>
      <Field label="Name">{(fid) => <Input id={fid} value={text.name} onChange={set("name")} />}</Field>
      {shape === "is-true" ? <Field label="Is it true that…" hint="The decision model answers yes or no; no fails the rule.">{(fid, hid) => <Textarea id={fid} aria-describedby={hid} rows={2} value={text.claim} onChange={set("claim")} />}</Field> : null}
      {shape === "score" ? (
        <>
          <Field label="What to score">{(fid) => <Input id={fid} value={text.subject} onChange={set("subject")} />}</Field>
          <Field label="Levels" hint="One level per line, worst first, 2 to 10.">{(fid, hid) => <Textarea id={fid} aria-describedby={hid} rows={4} value={text.levels} onChange={set("levels")} />}</Field>
          <Field label="Fail below" hint="One of the levels after the first; empty never fails.">{(fid, hid) => <Input id={fid} aria-describedby={hid} value={text.failBelow} onChange={set("failBelow")} />}</Field>
        </>
      ) : null}
      {shape === "choose" ? (
        <>
          <Field label="Which of these is it" hint="One choice per line, at least two.">{(fid, hid) => <Textarea id={fid} aria-describedby={hid} rows={3} value={text.options} onChange={set("options")} />}</Field>
          {linesOf(text.options).length > 0 && <p className="hint">Fail on</p>}
          {linesOf(text.options).map((option) => <Checkbox key={option} checked={text.failOn.includes(option)} onCheckedChange={failOn(option)} label={option} />)}
        </>
      ) : null}
      <EditorFoot error={error} saveLabel={id ? "Save rule" : "Add rule"} onCancel={onCancel} />
    </form>
  );
}
