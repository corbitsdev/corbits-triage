import { useState } from "react";
import { Button, Switch } from "@corbits/react-ui";
import { customCheckEnabled, type CustomCheck } from "@corbits/triage-contracts";
import { checkFormOf, customCheckOf, type CheckForm } from "../../lib/action-builder.ts";
import { removeCustom, setCustomEnabled, upsertCustom, type RepoDraft } from "../../lib/pack-draft.ts";
import { shownReason } from "../../lib/pack-prose.ts";
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
  const [tried, setTried] = useState(false);
  const form = checkFormOf(check);
  // Read on every render, so the refusal clears once the action that blocked it changes.
  const removal = removeCustom(draft, check.id);
  const refused = tried && "reason" in removal ? shownReason(removal.reason, draft.pack) : "";

  function change(next: CheckForm) {
    edit((current) => upsertCustom(current, customCheckOf(next, check.id)));
  }

  function remove() {
    if ("reason" in removal) setTried(true);
    else edit(() => removal);
  }

  return (
    <div className={reason || refused ? "sentence custom invalid" : "sentence custom"} id={`rp-custom-${check.id}`}>
      <span className="txt">
        <input className="val name" aria-label="Rule name" disabled={disabled} value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />
        <CheckParams form={form} roles={Object.keys(draft.policy.roles)} disabled={disabled} onChange={change} />
        {stat ? <small>{stat}</small> : null}
        {reason ? <small className="reason">{reason}</small> : null}
        {refused ? <small role="alert" className="reason">{refused}</small> : null}
      </span>
      {check.kind === "model" ? <EvalBadge evaluation="model" /> : null}
      <Switch className="sw" checked={customCheckEnabled(check)} onCheckedChange={(enabled) => edit((current) => setCustomEnabled(current, check.id, enabled))} label={check.name} disabled={disabled} />
      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${check.name}`} disabled={disabled} onClick={remove}><CloseIcon /></Button>
    </div>
  );
}
