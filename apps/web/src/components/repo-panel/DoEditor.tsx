import { Button } from "@corbits/react-ui";
import { STEP_KINDS, type LabelsTarget, type PeopleTarget, type StepKind } from "@corbits/triage-contracts";
import type { DoForm } from "../../lib/action-builder.ts";
import { DO_NAMES } from "../../lib/pack-prose.ts";
import { CloseIcon } from "../inbox-icons.tsx";
import TokenList from "./TokenList.tsx";

const LABEL_SOURCES: Array<{ value: LabelsTarget["from"]; label: string }> = [
  { value: "list", label: "these labels" },
  { value: "verdict", label: "the verdict" },
  { value: "rules", label: "each failed rule" },
];

const RECIPIENTS: Array<{ value: PeopleTarget["to"]; label: string }> = [
  { value: "codeowners", label: "CODEOWNERS" },
  { value: "users", label: "people" },
  { value: "teams", label: "teams" },
  { value: "author", label: "the author" },
];

type DoEditorProps = { step: DoForm; note?: string; disabled: boolean; onChange: (step: DoForm) => void; onRemove: () => void };

/** One step: what it does, its target and whether it runs alone. */
export default function DoEditor({ step, note, disabled, onChange, onRemove }: DoEditorProps) {
  const recipients = RECIPIENTS.filter((option) => option.value !== "author" || step.kind === "assign");

  function set(patch: Partial<DoForm>) {
    onChange({ ...step, ...patch });
  }

  function setKind(kind: StepKind) {
    const people = kind === "assign" || kind === "request-review";
    const to = people && (!step.to || (kind === "request-review" && step.to === "author")) ? "codeowners" : step.to;
    const from = kind === "labels" && !step.from ? "list" : step.from;
    onChange({ ...step, kind, to, from });
  }

  function target() {
    switch (step.kind) {
      case "labels":
        return (
          <>
            <select className="val" aria-label="Labels from" disabled={disabled} value={step.from} onChange={(event) => set({ from: event.target.value as LabelsTarget["from"] })}>
              {LABEL_SOURCES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {step.from === "list" ? <TokenList values={step.labels ?? []} noun="label" mono disabled={disabled} onChange={(labels) => set({ labels })} /> : null}
          </>
        );
      case "assign":
      case "request-review":
        return (
          <>
            <select className="val" aria-label={step.kind === "assign" ? "Assign to" : "Request review from"} disabled={disabled} value={step.to} onChange={(event) => set({ to: event.target.value as PeopleTarget["to"] })}>
              {recipients.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {step.to === "users" ? <TokenList values={step.users ?? []} noun="person" placeholder="login" disabled={disabled} onChange={(users) => set({ users })} /> : null}
            {step.to === "teams" ? <TokenList values={step.teams ?? []} noun="team" placeholder="@org/team" disabled={disabled} onChange={(teams) => set({ teams })} /> : null}
          </>
        );
      case "comment":
        return <textarea className="val w body" aria-label="Comment" rows={2} disabled={disabled} value={step.body ?? ""} onChange={(event) => set({ body: event.target.value })} />;
      case "approve":
      case "merge":
      case "request-changes":
      case "close":
      case "nothing":
        return null;
    }
  }

  return (
    <div className="do">
      <span className="txt">
        <select className="val" aria-label="Do" disabled={disabled} value={step.kind} onChange={(event) => setKind(event.target.value as StepKind)}>
          {STEP_KINDS.map((kind) => <option key={kind} value={kind}>{DO_NAMES[kind]}</option>)}
        </select>
        {target()}
        {note ? <small>{note}</small> : null}
      </span>
      <Button type="button" variant="ghost" size="icon" aria-label="Remove this Do" disabled={disabled} onClick={onRemove}><CloseIcon /></Button>
    </div>
  );
}
