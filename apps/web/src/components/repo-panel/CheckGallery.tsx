import { useState } from "react";
import { Button } from "@corbits/react-ui";
import type { CustomCheck } from "@corbits/triage-contracts";
import { buildCustomCheck, checkFormOfKind, type CheckForm } from "../../lib/action-builder.ts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { shownReason, type CheckKind } from "../../lib/pack-prose.ts";
import CheckFields from "./CheckFields.tsx";
import CheckKindPicker from "./CheckKindPicker.tsx";

type CheckGalleryProps = { draft: RepoDraft; disabled: boolean; onAdd: (check: CustomCheck) => void; onCancel: () => void };

/** A new custom check: pick a rule kind or a model shape, then fill in its typed form. */
export default function CheckGallery({ draft, disabled, onAdd, onCancel }: CheckGalleryProps) {
  const [form, setForm] = useState<CheckForm | null>(null);
  /** A fresh form is not yet wrong, so its reason waits for the first edit or an attempt to add. */
  const [touched, setTouched] = useState(false);
  function pick(kind: CheckKind) {
    setForm(checkFormOfKind(kind));
    setTouched(false);
  }

  function change(next: CheckForm) {
    setForm(next);
    setTouched(true);
  }

  if (!form) return <CheckKindPicker disabled={disabled} onPick={pick} onCancel={onCancel} />;
  const built = buildCustomCheck(form, draft.pack);

  function add() {
    if ("reason" in built) setTouched(true);
    else onAdd(built);
  }

  return (
    <div className="gallery" role="group" aria-label="New check">
      <CheckFields form={form} roles={Object.keys(draft.policy.roles)} disabled={disabled} onChange={change} />
      {touched && "reason" in built ? <p className="reason">{shownReason(built.reason, draft.pack)}</p> : null}
      <div className="pfoot">
        <button type="button" className="linkish" onClick={() => setForm(null)}>Back</button>
        <span className="sp" />
        <button type="button" className="linkish" onClick={onCancel}>Cancel</button>
        <Button type="button" variant="outline" size="sm" disabled={disabled || (touched && "reason" in built)} onClick={add}>Add check</Button>
      </div>
    </div>
  );
}
