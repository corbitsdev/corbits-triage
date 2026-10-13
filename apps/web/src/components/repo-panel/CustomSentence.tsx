import { Button, Switch } from "@corbits/react-ui";
import { customCheckEnabled, type CustomCheck } from "@corbits/triage-contracts";
import { checkFormOf, customCheckOf, type CheckForm } from "../../lib/action-builder.ts";
import { removeCustom, setCustomEnabled, upsertCustom, type RepoDraft } from "../../lib/pack-draft.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import { CloseIcon } from "../inbox-icons.tsx";
import CheckParams from "./CheckParams.tsx";
import EvalBadge from "./EvalBadge.tsx";

type CustomSentenceProps = {
  check: CustomCheck;
  draft: RepoDraft;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Why the draft cannot be saved, when this check is the reason. */
  reason?: string;
  stat: string | null;
};

/** A custom check as a sentence like the built-in ones: its name, its values inline, a switch and a remove. */
export default function CustomSentence({ check, draft, disabled, edit, reason, stat }: CustomSentenceProps) {
  const form = checkFormOf(check);

  function change(next: CheckForm) {
    edit((current) => upsertCustom(current, customCheckOf(next, check.id)));
  }

  return (
    <div className={reason ? "sentence custom invalid" : "sentence custom"} id={`rp-custom-${check.id}`}>
      <span className="txt">
        <input className="val name" aria-label="Rule name" disabled={disabled} value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />
        <CheckParams form={form} roles={Object.keys(draft.policy.roles)} disabled={disabled} onChange={change} />
        {stat ? <small>{stat}</small> : null}
        {reason ? <small className="reason">{reason}</small> : null}
      </span>
      {check.kind === "model" ? <EvalBadge evaluation="model" /> : null}
      <Switch className="sw" checked={customCheckEnabled(check)} onCheckedChange={(enabled) => edit((current) => setCustomEnabled(current, check.id, enabled))} label={check.name} disabled={disabled} />
      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${check.name}`} disabled={disabled} onClick={() => edit((current) => removeCustom(current, check.id))}><CloseIcon /></Button>
    </div>
  );
}
