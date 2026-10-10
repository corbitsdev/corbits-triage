import { Switch } from "@corbits/react-ui";
import { ACTION_KINDS, type ActionKind, type LabelsTarget, type PeopleTarget } from "@corbits/triage-contracts";
import type { DoForm } from "../../lib/action-builder.ts";
import { DO_NAMES, MANUAL_ONLY, type Branch } from "../../lib/pack-prose.ts";
import { CloseIcon } from "../inbox-icons.tsx";
import TokenList from "./TokenList.tsx";

const LABEL_SOURCES: Array<{ value: LabelsTarget["from"]; label: string }> = [
  { value: "list", label: "these labels" },
  { value: "type", label: "by type" },
  { value: "paths", label: "by paths" },
];

const RECIPIENTS: Array<{ value: PeopleTarget["to"]; label: string }> = [
  { value: "codeowners", label: "CODEOWNERS" },
  { value: "role", label: "a role" },
  { value: "users", label: "people" },
  { value: "teams", label: "teams" },
  { value: "author", label: "the author" },
];

type DoEditorProps = { step: DoForm; branch: Branch; roles: string[]; disabled: boolean; onChange: (step: DoForm) => void; onRemove: () => void };

/** One Do: its kind, its target and whether it runs without asking. */
export default function DoEditor({ step, branch, roles, disabled, onChange, onRemove }: DoEditorProps) {
  const manual = MANUAL_ONLY[branch].includes(step.kind);
  // Agent Dos cannot run yet, so they are offered only to keep one that is already stored.
  const kinds = ACTION_KINDS.filter((kind) => kind !== "agent" || step.kind === "agent");
  const recipients = RECIPIENTS.filter((option) => option.value !== "author" || step.kind === "assign");

  function set(patch: Partial<DoForm>) {
    onChange({ ...step, ...patch });
  }

  function setKind(kind: ActionKind) {
    const people = kind === "assign" || kind === "request-review";
    const to = people && (!step.to || (kind === "request-review" && step.to === "author")) ? "codeowners" : step.to;
    const from = kind === "labels" && !step.from ? "list" : step.from;
    onChange({ ...step, kind, to, from, automatic: step.automatic && !MANUAL_ONLY[branch].includes(kind) });
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
            {step.to === "role" ? (
              <select className="val" aria-label="Role" disabled={disabled} value={step.role ?? ""} onChange={(event) => set({ role: event.target.value })}>
                <option value="" disabled>Pick a role</option>
                {[...new Set([...roles, ...(step.role ? [step.role] : [])])].map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            ) : null}
            {step.to === "users" ? <TokenList values={step.users ?? []} noun="person" placeholder="login" disabled={disabled} onChange={(users) => set({ users })} /> : null}
            {step.to === "teams" ? <TokenList values={step.teams ?? []} noun="team" placeholder="@org/team" disabled={disabled} onChange={(teams) => set({ teams })} /> : null}
          </>
        );
      case "comment":
        return <textarea className="val w body" aria-label="Comment" rows={2} disabled={disabled} value={step.body ?? ""} onChange={(event) => set({ body: event.target.value })} />;
      case "agent":
        return <textarea className="val w body" aria-label="Agent prompt" rows={2} disabled={disabled} value={step.prompt ?? ""} onChange={(event) => set({ prompt: event.target.value })} />;
      case "close":
        return null;
    }
  }

  return (
    <div className="do">
      <span className="txt">
        <select className="val" aria-label="Do" disabled={disabled} value={step.kind} onChange={(event) => setKind(event.target.value as ActionKind)}>
          {kinds.map((kind) => <option key={kind} value={kind}>{DO_NAMES[kind]}</option>)}
        </select>
        {target()}
      </span>
      <span className="auto" title={manual ? `Cannot ${DO_NAMES[step.kind].toLowerCase()} automatically here` : undefined}>
        Automatic
        <Switch className="sw" checked={step.automatic && !manual} onCheckedChange={(automatic) => set({ automatic })} label="Automatic" disabled={disabled || manual} />
      </span>
      <button type="button" className="btn btn-quiet btn-sm icon" aria-label="Remove this Do" disabled={disabled} onClick={onRemove}><CloseIcon /></button>
    </div>
  );
}
