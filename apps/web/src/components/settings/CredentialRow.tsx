import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { generateWebhookSecret } from "../../lib/connect-view.ts";
import { runCredentialAction } from "../../lib/credential-actions.ts";
import { isActiveCredential, type HubCredential } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyField } from "../CopyField.tsx";

type CredentialRowProps = {
  credential: HubCredential;
  name: string;
  /** True for the GitHub App's webhook secret, which Triage generates; false where this row only removes. */
  rotatable: boolean;
  /** Removes the secret where removing it also takes down what uses it; otherwise it is revoked. */
  remove?: (credentialId: string) => Promise<void>;
};

type Change = { action: "rotate" | "revoke"; secret: string };

function confirmChange(message: string): boolean {
  return window.confirm(message);
}

export function CredentialRow({ credential, name, rotatable, remove }: CredentialRowProps) {
  const { replaceSecret, revoke, readOnly } = usePortal();
  // Shown once, until dismissed: the vault never returns it.
  const [rotated, setRotated] = useState("");
  const change = useMutation({
    mutationFn: async function applyChange({ action, secret }: Change) {
      return runCredentialAction(action, credential, secret, { confirm: confirmChange, replaceSecret, revoke: remove ?? revoke }, name);
    },
    onSuccess: function showRotated(completed, { action, secret }) {
      if (completed && action === "rotate") setRotated(secret);
    },
  });
  const disabled = readOnly || change.isPending;
  const active = isActiveCredential(credential);

  return (
    <div className="sentence">
      <div className="rmain">
        <div className="rline"><span className="w">{name} secret</span><span className="model">{active ? "stored" : credential.status.toLowerCase()}</span></div>
        {rotated && (
          <>
            <CopyField label="New webhook secret" value={rotated} help="Paste it as the webhook secret in your GitHub App's settings on GitHub now. Pull requests that change before you do are picked up automatically. Triage does not show this secret again." />
            <div className="rline"><Button type="button" variant="outline" size="sm" onClick={() => setRotated("")}>I pasted it on GitHub</Button></div>
          </>
        )}
        {change.error && <p role="alert" className="field-error">Could not change the {name} secret. {errorText(change.error)} Try again.</p>}
      </div>
      {rotatable && !rotated && <Button type="button" variant="outline" size="sm" aria-label={`Rotate ${name} secret`} disabled={disabled} onClick={() => change.mutate({ action: "rotate", secret: generateWebhookSecret() })}>{change.isPending && change.variables.action === "rotate" ? "Rotating…" : "Rotate secret"}</Button>}
      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => change.mutate({ action: "revoke", secret: "" })}>Remove</Button>
    </div>
  );
}
