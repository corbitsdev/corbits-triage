import type { CheckForm } from "../../lib/action-builder.ts";
import TokenList from "./TokenList.tsx";

type CheckParamsProps = { form: CheckForm; disabled: boolean; onChange: (form: CheckForm) => void };

/** One model shape's parameters, as a sentence with its values inline. */
export default function CheckParams({ form, disabled, onChange }: CheckParamsProps) {
  function set(patch: Partial<CheckForm>) {
    onChange({ ...form, ...patch });
  }

  function text(key: "claim" | "subject", label: string) {
    return <input className="val w" aria-label={label} disabled={disabled} value={form[key] ?? ""} onChange={(event) => set({ [key]: event.target.value })} />;
  }

  switch (form.shape) {
    case "is-true":
      return <>Is it true that {text("claim", "Claim")}?</>;
    case "score": {
      const levels = form.levels ?? [];
      return (
        <>
          Score {text("subject", "What to score")} as <TokenList values={levels} noun="level" disabled={disabled} onChange={(values) => set({ levels: values, failBelow: form.failBelow !== undefined && values.indexOf(form.failBelow) > 0 ? form.failBelow : undefined })} />, worst first; fail below
          <select className="val" aria-label="Fail below" disabled={disabled} value={form.failBelow ?? ""} onChange={(event) => set({ levels, failBelow: event.target.value || undefined })}>
            <option value="">never</option>
            {levels.slice(1).map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </>
      );
    }
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
