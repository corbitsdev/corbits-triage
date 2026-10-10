import type { CheckPackGroup } from "@corbits/triage-contracts";
import type { CheckForm } from "../../lib/action-builder.ts";
import TokenList from "./TokenList.tsx";

const GROUPS: Array<{ id: CheckPackGroup; label: string }> = [
  { id: "pull-request", label: "Pull request" },
  { id: "issue", label: "Issue" },
  { id: "around", label: "Around it" },
  { id: "code-vs-ci", label: "Code vs CI" },
];

type CheckFieldsProps = { form: CheckForm; disabled: boolean; onChange: (form: CheckForm) => void };

/** The name, group and the parameters of one rule kind or model shape. */
export default function CheckFields({ form, disabled, onChange }: CheckFieldsProps) {
  function set(patch: Partial<CheckForm>) {
    onChange({ ...form, ...patch } as CheckForm);
  }

  function text(key: "pattern" | "label" | "claim" | "subject", label: string, mono = false) {
    return <input className={mono ? "val w mono-val" : "val w"} aria-label={label} disabled={disabled} value={form[key] ?? ""} onChange={(event) => set({ [key]: event.target.value })} />;
  }

  function count(key: "count" | "min", label: string, min: number, max?: number) {
    return <input className="val" type="number" aria-label={label} min={min} max={max} step={1} disabled={disabled} value={form[key] ?? ""} onChange={(event) => set({ [key]: event.target.value === "" ? undefined : Number(event.target.value) })} />;
  }

  function tokens(key: "globs" | "changed" | "requires", noun: string) {
    return <TokenList values={form[key] ?? []} noun={noun} mono disabled={disabled} onChange={(values) => set({ [key]: values })} />;
  }

  function params() {
    if (form.kind === "model") {
      switch (form.shape) {
        case "is-true":
          return <>Is it true that {text("claim", "Claim")}?</>;
        case "score":
          return <>Score {text("subject", "What to score")} from 0 to 10, pass at {count("min", "Minimum score", 0, 10)} or above.</>;
        case "choose": {
          const options = form.options ?? [];
          return (
            <>
              Which of <TokenList values={options} noun="choice" disabled={disabled} onChange={(values) => set({ options: values, failOn: (form.failOn ?? []).filter((item) => values.includes(item)) })} /> is it? Fail on
              {options.map((option) => (
                <label key={option} className="pick">
                  <input type="checkbox" disabled={disabled} checked={(form.failOn ?? []).includes(option)} onChange={(event) => set({ failOn: event.target.checked ? [...(form.failOn ?? []), option] : (form.failOn ?? []).filter((item) => item !== option) })} />
                  {option}
                </label>
              ))}
            </>
          );
        }
      }
    }
    switch (form.rule) {
      case "paths-unchanged":
        return <>Fail if any of {tokens("globs", "path")} changes.</>;
      case "paths-together":
        return <>When {tokens("changed", "path")} changes, {tokens("requires", "path")} must change too.</>;
      case "title-pattern":
        return <>Title must match {text("pattern", "Title pattern", true)}</>;
      case "branch-pattern":
        return <>Branch must match {text("pattern", "Branch pattern", true)}</>;
      case "diff-excludes":
        return <>Added lines must not match {text("pattern", "Diff pattern", true)}</>;
      case "label-required":
        return <>Require the label {text("label", "Required label")}</>;
      case "min-approvals":
        return <>Require at least {count("count", "Approvals", 1)} approvals</>;
    }
  }

  return (
    <div className="check-fields">
      <label>Name <input className="val w" aria-label="Check name" disabled={disabled} value={form.name} onChange={(event) => set({ name: event.target.value })} /></label>
      <label>Looks at
        <select className="val" aria-label="Where the check looks" disabled={disabled} value={form.group} onChange={(event) => set({ group: event.target.value as CheckPackGroup })}>
          {GROUPS.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        </select>
      </label>
      <p className="txt">{params()}</p>
    </div>
  );
}
