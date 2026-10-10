import type { DoForm } from "../../lib/action-builder.ts";
import { BRANCH_NAMES, type Branch } from "../../lib/pack-prose.ts";
import DoEditor from "./DoEditor.tsx";

const HINTS: Record<Branch, string> = {
  yes: "every check passes",
  no: "a check fails",
  unsure: "a check is not confirmed",
  always: "every time",
};

const NEW_DO: DoForm = { kind: "labels", automatic: false, from: "list", labels: [] };

type BranchEditorProps = { branch: Branch; dos: DoForm[]; roles: string[]; disabled: boolean; onChange: (dos: DoForm[]) => void };

/** The Dos that run on one outcome of the checks. */
export default function BranchEditor({ branch, dos, roles, disabled, onChange }: BranchEditorProps) {
  function replace(index: number) {
    return function withStep(step: DoForm) {
      onChange(dos.map((item, i) => (i === index ? step : item)));
    };
  }

  return (
    <div className="branch" role="group" aria-label={BRANCH_NAMES[branch]}>
      <div className="branch-h"><b>{BRANCH_NAMES[branch]}</b> <span>{HINTS[branch]}</span></div>
      {dos.map((step, index) => (
        <DoEditor key={index} step={step} branch={branch} roles={roles} disabled={disabled} onChange={replace(index)} onRemove={() => onChange(dos.filter((_, i) => i !== index))} />
      ))}
      <button type="button" className="linkish" disabled={disabled} onClick={() => onChange([...dos, NEW_DO])}>Add a Do</button>
    </div>
  );
}
