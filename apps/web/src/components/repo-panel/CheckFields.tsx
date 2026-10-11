import type { CheckPackGroup } from "@corbits/triage-contracts";
import type { CheckForm } from "../../lib/action-builder.ts";
import CheckParams from "./CheckParams.tsx";

const GROUPS: Array<{ id: CheckPackGroup; label: string }> = [
  { id: "pull-request", label: "Pull request" },
  { id: "issue", label: "Issue" },
  { id: "around", label: "Around it" },
  { id: "code-vs-ci", label: "Code vs CI" },
];

type CheckFieldsProps = { form: CheckForm; roles: string[]; disabled: boolean; onChange: (form: CheckForm) => void };

/** The name, group and the parameters of one rule kind or model shape. */
export default function CheckFields({ form, roles, disabled, onChange }: CheckFieldsProps) {
  function set(patch: Partial<CheckForm>) {
    onChange({ ...form, ...patch } as CheckForm);
  }

  return (
    <div className="check-fields">
      <label>Name <input className="val w" aria-label="Check name" disabled={disabled} value={form.name} onChange={(event) => set({ name: event.target.value })} /></label>
      <label>Looks at
        <select className="val" aria-label="Where the check looks" disabled={disabled} value={form.group} onChange={(event) => set({ group: event.target.value as CheckPackGroup })}>
          {GROUPS.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
        </select>
      </label>
      <p className="txt"><CheckParams form={form} roles={roles} disabled={disabled} onChange={onChange} /></p>
    </div>
  );
}
