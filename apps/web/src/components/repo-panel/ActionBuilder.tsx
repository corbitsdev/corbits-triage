import { useState } from "react";
import type { Action, CheckPack, CheckRef, CustomCheck } from "@corbits/triage-contracts";
import { actionFormOf, buildAction, type ActionForm } from "../../lib/action-builder.ts";
import type { TriageStats } from "../../lib/hub-api.ts";
import { removeCustom, upsertCustom, type RepoDraft } from "../../lib/pack-draft.ts";
import { shownReason } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import BranchEditor from "./BranchEditor.tsx";
import CheckGallery from "./CheckGallery.tsx";
import CheckPicker from "./CheckPicker.tsx";
import WhenPicker from "./WhenPicker.tsx";

function withoutCheck(draft: RepoDraft, id: string): RepoDraft {
  const next = removeCustom(draft, id);
  return "reason" in next ? draft : next;
}

const BLANK: ActionForm = { when: "every", checks: [], yes: [], no: [], unsure: [], always: [] };

type ActionBuilderProps = {
  /** The action being edited; a new one gets the next free id. */
  action?: Action;
  draft: RepoDraft;
  saved: CheckPack;
  stats: TriageStats | undefined;
  disabled: boolean;
  edit: RepoPack["edit"];
  onDone: (action: Action) => void;
  onCancel: () => void;
  onRemove?: () => void;
};

/** When, Checks, then the Dos per outcome; Add goes through only once the action would be accepted as written. */
export default function ActionBuilder({ action, draft, saved, stats, disabled, edit, onDone, onCancel, onRemove }: ActionBuilderProps) {
  const [form, setForm] = useState<ActionForm>(() => (action ? actionFormOf(action) : BLANK));
  const [creating, setCreating] = useState(false);
  /** A blank form is not yet wrong, so its reason waits for the first edit or an attempt to add. */
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<CheckRef[]>([]);
  const built = action ? buildAction(form, draft.pack, action.id) : buildAction(form, draft.pack);
  const roles = Object.keys(draft.policy.roles);

  function set(patch: Partial<ActionForm>) {
    setForm((current) => ({ ...current, ...patch }));
    setTouched(true);
  }

  function addCheck(check: CustomCheck) {
    edit((current) => upsertCustom(current, check));
    set({ checks: [...form.checks, check.id as CheckRef] });
    setCreated([...created, check.id as CheckRef]);
    setCreating(false);
  }

  /** Checks made here but not kept on the action come back out of the draft, so they never join the verdict unasked. */
  function dropCreated(kept: CheckRef[]) {
    const unused = created.filter((id) => !kept.includes(id));
    if (unused.length > 0) edit((current) => unused.reduce(withoutCheck, current));
  }

  function done() {
    if ("reason" in built) {
      setTouched(true);
      return;
    }
    dropCreated(built.checks);
    onDone(built);
  }

  function cancel() {
    dropCreated([]);
    onCancel();
  }

  function remove() {
    dropCreated([]);
    onRemove?.();
  }

  const branches = form.checks.length === 0 ? (["always"] as const) : (["yes", "no", "unsure"] as const);
  return (
    <div className="builder" role="group" aria-label={action ? `Edit ${action.id}` : "New action"}>
      <div className="blk"><span className="bl">When</span><WhenPicker when={form.when} disabled={disabled} onChange={(when) => set({ when })} /></div>
      <div className="blk">
        <span className="bl">Checks</span>
        <CheckPicker checks={form.checks} draft={draft} saved={saved} stats={stats} disabled={disabled} edit={edit} onChange={(checks) => set({ checks })} onNewCheck={() => setCreating(true)} />
      </div>
      {creating ? <CheckGallery draft={draft} disabled={disabled} onAdd={addCheck} onCancel={() => setCreating(false)} /> : null}
      {branches.map((branch) => (
        <BranchEditor key={branch} branch={branch} dos={form[branch]} roles={roles} disabled={disabled} onChange={(dos) => set({ [branch]: dos })} />
      ))}
      {touched && "reason" in built ? <p className="reason">{shownReason(built.reason, draft.pack)}</p> : null}
      <div className="bfoot">
        <button type="button" className="btn btn-sm" disabled={disabled || (touched && "reason" in built)} onClick={done}>{action ? "Save action" : "Add action"}</button>
        <button type="button" className="linkish" onClick={cancel}>Cancel</button>
        {onRemove ? <span className="end"><button type="button" className="linkish" disabled={disabled} onClick={remove}>Remove action</button></span> : null}
      </div>
    </div>
  );
}
