import { useState } from "react";
import type { CustomCheck } from "@corbits/triage-contracts";
import { buildCustomCheck, type CheckForm } from "../../lib/action-builder.ts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { CHECK_KINDS, shownReason } from "../../lib/pack-prose.ts";
import CheckFields from "./CheckFields.tsx";
import EvalBadge from "./EvalBadge.tsx";

type CheckGalleryProps = { draft: RepoDraft; disabled: boolean; onAdd: (check: CustomCheck) => void; onCancel: () => void };

function formOf(kind: (typeof CHECK_KINDS)[number]): CheckForm {
  const name = kind.title.replace(/…$/, "");
  return kind.evaluation === "rule"
    ? { name, group: "pull-request", kind: "rule", rule: kind.rule }
    : { name, group: "pull-request", kind: "model", shape: kind.shape };
}

/** A new custom check: pick a rule kind or a model shape, then fill in its typed form. */
export default function CheckGallery({ draft, disabled, onAdd, onCancel }: CheckGalleryProps) {
  const [form, setForm] = useState<CheckForm | null>(null);
  /** A fresh form is not yet wrong, so its reason waits for the first edit or an attempt to add. */
  const [touched, setTouched] = useState(false);
  function pick(kind: (typeof CHECK_KINDS)[number]) {
    setForm(formOf(kind));
    setTouched(false);
  }

  function change(next: CheckForm) {
    setForm(next);
    setTouched(true);
  }

  if (!form) {
    return (
      <div className="gallery" role="group" aria-label="New check">
        {CHECK_KINDS.map((kind) => (
          <div key={kind.title} className="gallery-row">
            <span><b>{kind.title}</b> {kind.line}</span>
            <EvalBadge evaluation={kind.evaluation} />
            <button type="button" className="btn btn-sm" aria-label={`Use ${kind.title}`} disabled={disabled} onClick={() => pick(kind)}>Use</button>
          </div>
        ))}
        <div className="pfoot"><span /><button type="button" className="linkish" onClick={onCancel}>Cancel</button></div>
      </div>
    );
  }
  const built = buildCustomCheck(form, draft.pack);

  function add() {
    if ("reason" in built) setTouched(true);
    else onAdd(built);
  }

  return (
    <div className="gallery" role="group" aria-label="New check">
      <CheckFields form={form} disabled={disabled} onChange={change} />
      {touched && "reason" in built ? <p className="reason">{shownReason(built.reason, draft.pack)}</p> : null}
      <div className="pfoot">
        <button type="button" className="linkish" onClick={() => setForm(null)}>Back</button>
        <span className="sp" />
        <button type="button" className="linkish" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-sm" disabled={disabled || (touched && "reason" in built)} onClick={add}>Add check</button>
      </div>
    </div>
  );
}
