import { alwaysHeld, type ActionKind, type Step, type StepKind, type VerdictWord } from "@corbits/triage-contracts";
import { buildDo, doFormOf } from "../../lib/action-builder.ts";
import { LIST_NAMES } from "../../lib/pack-prose.ts";
import DoEditor from "./DoEditor.tsx";

const HINTS: Record<VerdictWord, string> = {
  pass: "the pull request passes its policy",
  fail: "a rule fails, or the decision model is sure it does not pass",
  unsure: "the decision model cannot tell",
};

const NEW_DO: Step = { do: "labels", target: { from: "list", labels: [] } };

type VerdictListProps = {
  list: VerdictWord;
  dos: Step[];
  /** Whether triage runs a Do of this kind without asking; undefined while its grants are unknown. */
  alone: ((kind: ActionKind) => boolean) | undefined;
  fired: { suggested: number; executed: number } | undefined;
  disabled: boolean;
  /** Why the draft cannot be saved, when this list is the reason. */
  reason?: string;
  onChange: (dos: Step[]) => void;
};

/** The Dos that run on one verdict; Unsure starts collapsed. */
export default function VerdictList({ list, dos, alone, fired, disabled, reason, onChange }: VerdictListProps) {
  function note(kind: StepKind): string | undefined {
    if (alone === undefined || kind === "nothing") return undefined;
    return alone(kind) && !alwaysHeld(list, kind) ? "Runs alone" : "Waits for you";
  }

  return (
    <details className={reason ? "branch invalid" : "branch"} id={`rp-list-${list}`} open={list !== "unsure" || reason !== undefined}>
      <summary className="branch-h"><b>{LIST_NAMES[list]}</b> <span>{HINTS[list]}{dos.length ? "" : ", nothing to do"}</span></summary>
      {dos.map((step, index) => (
        <DoEditor
          key={index}
          step={doFormOf(step)}
          note={note(step.do)}
          disabled={disabled}
          onChange={(form) => onChange(dos.map((item, i) => (i === index ? buildDo(form) : item)))}
          onRemove={() => onChange(dos.filter((_, i) => i !== index))}
        />
      ))}
      <button type="button" className="linkish" disabled={disabled} onClick={() => onChange([...dos, NEW_DO])}>Add a Do</button>
      {fired && fired.suggested > 0 ? <p className="hint">Fired {fired.suggested === 1 ? "once" : `${fired.suggested} times`}, {fired.executed} done</p> : null}
      {reason ? <p className="reason">{reason}</p> : null}
    </details>
  );
}
