import { AUTHOR_KINDS, type AuthorWho } from "@corbits/triage-contracts";
import type { CheckForm } from "../../lib/action-builder.ts";
import CountField from "./CountField.tsx";
import TokenList from "./TokenList.tsx";

type CheckParamsProps = { form: CheckForm; roles: string[]; disabled: boolean; onChange: (form: CheckForm) => void };

const WHO: Record<AuthorWho, string> = { kinds: "a kind of contributor", users: "one of these people", role: "in a role" };

/** One rule kind's or model shape's parameters, as a sentence with its values inline. */
export default function CheckParams({ form, roles, disabled, onChange }: CheckParamsProps) {
  function set(patch: Partial<CheckForm>) {
    onChange({ ...form, ...patch } as CheckForm);
  }

  function text(key: "pattern" | "label" | "claim" | "subject", label: string, mono = false) {
    return <input className={mono ? "val w mono-val" : "val w"} aria-label={label} disabled={disabled} value={form[key] ?? ""} onChange={(event) => set({ [key]: event.target.value })} />;
  }

  function count(key: "count" | "min", label: string, min: number, max?: number) {
    return <CountField value={form[key]} label={label} min={min} max={max} disabled={disabled} onChange={(value) => set({ [key]: value })} />;
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
      case "author":
        return (
          <>
            Author is
            <select className="val" aria-label="Author is" disabled={disabled} value={form.who} onChange={(event) => set({ who: event.target.value as AuthorWho })}>
              {Object.entries(WHO).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            {form.who === "users" ? <TokenList values={form.users ?? []} noun="person" placeholder="login" disabled={disabled} onChange={(users) => set({ users })} /> : null}
            {form.who === "role" ? (
              <select className="val" aria-label="Role" disabled={disabled} value={form.role ?? ""} onChange={(event) => set({ role: event.target.value })}>
                <option value="" disabled>Pick a role</option>
                {[...new Set([...roles, ...(form.role ? [form.role] : [])])].map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            ) : null}
            {form.who === "kinds" ? <span className="picks">{AUTHOR_KINDS.map((kind) => (
              <label key={kind} className="pick">
                <input type="checkbox" disabled={disabled} checked={(form.kinds ?? []).includes(kind)} onChange={(event) => set({ kinds: event.target.checked ? [...(form.kinds ?? []), kind] : (form.kinds ?? []).filter((item) => item !== kind) })} />
                {kind}
              </label>
            ))}</span> : null}
          </>
        );
    }
  }

  return params();
}
