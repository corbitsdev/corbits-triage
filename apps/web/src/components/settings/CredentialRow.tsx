import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { generateWebhookSecret } from "../../lib/connect-view.ts";
import { runCredentialAction } from "../../lib/credential-actions.ts";
import { isActiveCredential, type HubCredential } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyField } from "../CopyField.tsx";
import { RestartFailed, useRestartTriage } from "./RestartFailed.tsx";

type CredentialRowProps = {
  credential: HubCredential;
  name: string;
  /** True for the GitHub App's webhook secret, which Triage generates; false where this row only removes. */
  rotatable: boolean;
  /** Removes the secret where removing it also takes down what uses it; otherwise it is revoked. */
  remove?: (credentialId: string) => Promise<void>;
};

type Action = "rotate" | "revoke";

function confirmChange(message: string): boolean {
  return window.confirm(message);
}

export function CredentialRow({ credential, name, rotatable, remove }: CredentialRowProps) {
  const { replaceSecret, revoke, readOnly } = usePortal();
  const restart = useRestartTriage("github");
  // Shown once, until dismissed: the vault never returns it.
  const [rotated, setRotated] = useState("");
  const change = useMutation({
    /** The new secret, once it is saved. */
    mutationFn: async function applyChange(action: Action): Promise<string | undefined> {
      const secret = action === "rotate" ? generateWebhookSecret() : "";
      const completed = await runCredentialAction(action, credential, secret, { confirm: confirmChange, replaceSecret, revoke: remove ?? revoke }, name);
      return completed && action === "rotate" ? secret : undefined;
    },
    onSuccess: function showRotated(secret) {
      if (secret === undefined) return;
      setRotated(secret);
      restart.mutate();
    },
  });

  function rotate() {
    change.mutate("rotate");
  }

  function removeSecret() {
    change.mutate("revoke");
  }

  function dismiss() {
    setRotated("");
  }
  const disabled = readOnly || change.isPending;
  const active = isActiveCredential(credential);

  return (
    <div className="sentence">
      <div className="rmain">
        <div className="rline"><span className="w">{name} secret</span><span className="model">{active ? "stored" : credential.status.toLowerCase()}</span></div>
        {rotated && (
          <>
            <CopyField label="New webhook secret" value={rotated} help="Paste it as the webhook secret in your GitHub App's settings now; Triage does not show it again." />
            <div className="rline"><Button type="button" variant="outline" size="sm" onClick={dismiss}>I pasted it on GitHub</Button></div>
          </>
        )}
        {change.error && <p role="alert" className="field-error">Could not change the {name} secret. {errorText(change.error)} Try again.</p>}
        <RestartFailed restart={restart} />
      </div>
      {rotatable && !rotated && <Button type="button" variant="outline" size="sm" aria-label={`Rotate ${name} secret`} disabled={disabled} onClick={rotate}>{change.isPending && change.variables === "rotate" ? "Rotating…" : "Rotate secret"}</Button>}
      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={removeSecret}>Remove</Button>
    </div>
  );
}
