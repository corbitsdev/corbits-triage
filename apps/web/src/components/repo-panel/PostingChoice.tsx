import { useId } from "react";
import type { CleanupMode } from "@corbits/triage-contracts";

type PostingChoiceProps = { mode: CleanupMode; disabled: boolean; onChange: (mode: CleanupMode) => void };

const CHOICES: Array<{ mode: CleanupMode; title: string; line: string }> = [
  { mode: "human-approved", title: "Ask me before posting", line: "You approve each reply and label." },
  { mode: "automated", title: "Post automatically", line: "Labels and one reply. Never merges or closes." },
];

/** Whether the verdict's labels and reply post without asking. */
export default function PostingChoice({ mode, disabled, onChange }: PostingChoiceProps) {
  const name = useId();
  return (
    <section className="rs">
      <fieldset className="radio-cards" disabled={disabled}>
        <legend>Posting</legend>
        {CHOICES.map((choice) => (
          <label key={choice.mode}>
            <input className="sr-only" type="radio" name={name} checked={mode === choice.mode} aria-describedby={`${name}-${choice.mode}`} onChange={() => onChange(choice.mode)} />
            <span className="rdot" />
            <span><b>{choice.title}</b><span id={`${name}-${choice.mode}`}>{choice.line}</span></span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
