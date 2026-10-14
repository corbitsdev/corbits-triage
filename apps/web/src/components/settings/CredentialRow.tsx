import { useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { runCredentialAction } from "../../lib/credential-actions.ts";
import type { HubCredential } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";

type CredentialRowProps = {
  credential: HubCredential;
  name: string;
  /** False where this row only removes: another form writes the secret, or Triage did not create it. */
  replaceable: boolean;
};

type Change = { action: "rotate" | "revoke"; secret: string };

function confirmChange(message: string): boolean {
  return window.confirm(message);
}

export function CredentialRow({ credential, name, replaceable }: CredentialRowProps) {
  const { replaceSecret, revoke, readOnly } = usePortal();
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState("");
  const change = useMutation({
    mutationFn: async function applyChange({ action, secret: next }: Change) {
      return runCredentialAction(action, credential, next, { confirm: confirmChange, replaceSecret, revoke }, name);
    },
    onSuccess: function closeEditor(completed, { action }) {
      if (!completed || action !== "rotate") return;
      setSecret("");
      setEditing(false);
    },
  });
  const disabled = readOnly || change.isPending;
  const active = credential.status.toLowerCase() === "active";

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    change.mutate({ action: "rotate", secret });
  }

  function cancel() {
    setSecret("");
    setEditing(false);
  }

  return (
    <div className="sentence">
      <div className="rmain">
        <div className="rline"><span className="w">{name} secret</span><span className="model">{active ? "stored" : credential.status.toLowerCase()}</span></div>
        {editing && (
          <form className="rline" onSubmit={save}>
            <Input className="val w" type="password" aria-label={`New secret for ${name}`} value={secret} onChange={(event) => setSecret(event.target.value)} disabled={disabled} autoComplete="new-password" />
            <Button type="submit" size="sm" disabled={disabled || !secret}>{change.isPending ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={cancel}>Cancel</Button>
          </form>
        )}
        {change.error && <p role="alert" className="field-error">Could not change the {name} secret. {errorText(change.error)} Try again.</p>}
      </div>
      {replaceable && !editing && <Button type="button" variant="outline" size="sm" aria-label={`Replace ${name} secret`} disabled={disabled} onClick={() => setEditing(true)}>Replace secret</Button>}
      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => change.mutate({ action: "revoke", secret: "" })}>Remove</Button>
    </div>
  );
}
