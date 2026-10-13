import { Button, Checkbox, Input, Select, Textarea } from "@corbits/react-ui";
import { ISSUE_TRACKERS, type CatalogCheck, type CatalogId, type CheckPack, type IssueTracker, type ModelShape, type RuleKind } from "@corbits/triage-contracts";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { defaultLocalPack } from "../local-pack.ts";
import { withCatalogParams, withCustomCheck, type CustomForm } from "../pack-edit.ts";
import { ISSUE_TRACKER_NAMES } from "../prose.ts";

/** The catalog checks whose limits the pack lets a person set. */
export const EDITABLE_CATALOG: readonly CatalogId[] = ["max-files-changed", "max-lines-changed", "no-forbidden-paths", "linked-issue"];

function linesOf(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** A whole number from `min` up, or why not. */
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

/** A catalog check's limits; saved together, then the pull request is scored again. */
export function CatalogEditor({ id, pack, onSave, onCancel }: CatalogEditorProps) {
  const row: CatalogCheck = { ...defaultLocalPack(pack.repo).checks[id], ...pack.checks[id], enabled: pack.checks[id]?.enabled ?? false };
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

/** What a custom check is: a rule kind, or a model shape. */
export type CustomVariant = { kind: "rule"; rule: Exclude<RuleKind, "author"> } | { kind: "model"; shape: ModelShape };

/** The editor's text for each of a check's parameters, so switching nothing loses what was typed. */
type CustomText = { name: string; globs: string; changed: string; requires: string; pattern: string; label: string; count: string; claim: string; subject: string; min: string; options: string; failOn: string[] };

function textOf(form: CustomForm | undefined, name: string): CustomText {
  const text: CustomText = { name, globs: "", changed: "", requires: "", pattern: "", label: "", count: "1", claim: "", subject: "", min: "7", options: "", failOn: [] };
  if (!form) return text;
  const named = { ...text, name: form.name };
  if (form.kind === "model") {
    switch (form.shape) {
      case "is-true": return { ...named, claim: form.claim };
      case "score": return { ...named, subject: form.subject, min: String(form.min) };
      case "choose": return { ...named, options: form.options.join("\n"), failOn: form.failOn };
    }
  }
  switch (form.rule) {
    case "paths-unchanged": return { ...named, globs: form.globs.join("\n") };
    case "paths-together": return { ...named, changed: form.changed.join("\n"), requires: form.requires.join("\n") };
    case "title-pattern":
    case "branch-pattern":
    case "diff-excludes": return { ...named, pattern: form.pattern };
    case "label-required": return { ...named, label: form.label };
    case "min-approvals": return { ...named, count: String(form.count) };
    case "author": return named;
  }
}

function formOf(variant: CustomVariant, text: CustomText): CustomForm | string {
  const name = text.name.trim();
  if (!name) return "Give the rule a name.";
  if (variant.kind === "model") {
    const { kind, shape } = variant;
    switch (shape) {
      case "is-true": return { name, kind, shape, claim: text.claim.trim() };
      case "score": {
        const min = wholeNumber(text.min, 0, "The minimum score");
        return typeof min === "string" ? min : { name, kind, shape, subject: text.subject.trim(), min };
      }
      case "choose": {
        const options = linesOf(text.options);
        return { name, kind, shape, options, failOn: text.failOn.filter((option) => options.includes(option)) };
      }
    }
  }
  const { kind, rule } = variant;
  switch (rule) {
    case "paths-unchanged": return { name, kind, rule, globs: linesOf(text.globs) };
    case "paths-together": return { name, kind, rule, changed: linesOf(text.changed), requires: linesOf(text.requires) };
    case "title-pattern":
    case "branch-pattern":
    case "diff-excludes": return { name, kind, rule, pattern: text.pattern };
    case "label-required": return { name, kind, rule, label: text.label.trim() };
    case "min-approvals": {
      const count = wholeNumber(text.count, 1, "Approvals");
      return typeof count === "string" ? count : { name, kind, rule, count };
    }
  }
}

const PATTERN_HINT = "A regular expression, without slashes or flags.";
const GLOBS_HINT = "One per line. * matches within a folder, ** across folders.";

type CustomEditorProps = {
  variant: CustomVariant;
  pack: CheckPack;
  /** The check being edited; absent for a new one. */
  id?: string;
  form?: CustomForm;
  defaultName: string;
  onSave: (pack: CheckPack, id: string) => Promise<void>;
  onCancel: () => void;
};

/** A custom check's name and parameters, checked by the pack contract before it is saved. */
export function CustomEditor({ variant, pack, id, form, defaultName, onSave, onCancel }: CustomEditorProps) {
  const [text, setText] = useState(() => textOf(form, defaultName));
  const [error, setError] = useState<string | null>(null);
  const formRef = useFirstFieldFocus();
  const rule = variant.kind === "rule" ? variant.rule : undefined;
  const shape = variant.kind === "model" ? variant.shape : undefined;

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
    const next = formOf(variant, text);
    if (typeof next === "string") return setError(next);
    const changed = withCustomCheck(pack, next, id);
    if ("reason" in changed) return setError(changed.reason.replace(/^Custom rule \S+ /, ""));
    setError(null);
    await onSave(changed.pack, changed.id);
  }

  return (
    <form className="editor" ref={formRef} onSubmit={save} aria-label={id ? "Edit rule" : "New rule"}>
      <Field label="Name">{(fid) => <Input id={fid} value={text.name} onChange={set("name")} />}</Field>
      {rule === "paths-unchanged" ? <Field label="Fail if any of these change" hint={GLOBS_HINT}>{(fid, hid) => <Textarea id={fid} aria-describedby={hid} className="mono" rows={3} value={text.globs} onChange={set("globs")} />}</Field> : null}
      {rule === "paths-together" ? (
        <>
          <Field label="When any of these change" hint={GLOBS_HINT}>{(fid, hid) => <Textarea id={fid} aria-describedby={hid} className="mono" rows={3} value={text.changed} onChange={set("changed")} />}</Field>
          <Field label="One of these must change too">{(fid) => <Textarea id={fid} className="mono" rows={3} value={text.requires} onChange={set("requires")} />}</Field>
        </>
      ) : null}
      {rule === "title-pattern" || rule === "branch-pattern" || rule === "diff-excludes" ? (
        <Field label={rule === "diff-excludes" ? "Added lines must not match" : rule === "title-pattern" ? "Title must match" : "Branch must match"} hint={PATTERN_HINT}>
          {(fid, hid) => <Input id={fid} aria-describedby={hid} className="mono" spellCheck={false} value={text.pattern} onChange={set("pattern")} />}
        </Field>
      ) : null}
      {rule === "label-required" ? <Field label="Require the label">{(fid) => <Input id={fid} value={text.label} onChange={set("label")} />}</Field> : null}
      {rule === "min-approvals" ? <Field label="Require at least this many approvals">{(fid) => <Input id={fid} className="mono" inputMode="numeric" value={text.count} onChange={set("count")} />}</Field> : null}
      {shape === "is-true" ? <Field label="Is it true that…" hint="The decision model answers yes or no; no fails the rule.">{(fid, hid) => <Textarea id={fid} aria-describedby={hid} rows={2} value={text.claim} onChange={set("claim")} />}</Field> : null}
      {shape === "score" ? (
        <div className="field-pair">
          <Field label="What to score from 0 to 10">{(fid) => <Input id={fid} value={text.subject} onChange={set("subject")} />}</Field>
          <Field label="Pass at or above">{(fid) => <Input id={fid} className="mono" inputMode="numeric" value={text.min} onChange={set("min")} />}</Field>
        </div>
      ) : null}
      {shape === "choose" ? (
        <>
          <Field label="Which of these is it" hint="One choice per line, at least two.">{(fid, hid) => <Textarea id={fid} aria-describedby={hid} rows={3} value={text.options} onChange={set("options")} />}</Field>
          {linesOf(text.options).length ? <p className="hint">Fail on</p> : null}
          {linesOf(text.options).map((option) => <Checkbox key={option} checked={text.failOn.includes(option)} onCheckedChange={failOn(option)} label={option} />)}
        </>
      ) : null}
      <EditorFoot error={error} saveLabel={id ? "Save rule" : "Add rule"} onCancel={onCancel} />
    </form>
  );
}
