import { useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { connectGithubApp } from "../../lib/github-manifest.ts";
import { isActiveCredential, type HubCredential } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";

type GithubAppRowProps = {
  credential: HubCredential;
  name: string;
  tenantId: string;
  /** Only those who may manage the GitHub App replace its key. */
  replaceable: boolean;
  /** Removes the App and its key. */
  remove: (credentialId: string) => Promise<void>;
};

function tokenErrorOf(credential: HubCredential): string | undefined {
  const reason = credential.metadata?.["tokenError"];
  return typeof reason === "string" ? reason : undefined;
}

/** The GitHub App: its key is replaced with its App ID, which GitHub checks before it is saved. */
export function GithubAppRow({ credential, name, tenantId, replaceable, remove }: GithubAppRowProps) {
  const { readOnly, refresh, notify } = usePortal();
  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const replace = useMutation({
    mutationFn: function replaceKey() {
      return connectGithubApp(tenantId, { appId: appId.trim(), privateKey });
    },
    onSuccess: function closeEditor() {
      setAppId("");
      setPrivateKey("");
      setEditing(false);
      notify("GitHub App key replaced.");
      refresh();
    },
  });
  const removal = useMutation({
    mutationFn: async function removeApp() {
      if (!window.confirm(`Remove ${name}? Triage stops reading and acting on GitHub.`)) return;
      await remove(credential.id);
    },
  });
  const disabled = readOnly || replace.isPending || removal.isPending;
  const tokenError = tokenErrorOf(credential);

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    replace.mutate();
  }

  function cancel() {
    setAppId("");
    setPrivateKey("");
    setEditing(false);
  }

  return (
    <div className="sentence">
      <div className="rmain">
        <div className="rline"><span className="w">{name} secret</span><span className="model">{isActiveCredential(credential) ? "stored" : credential.status.toLowerCase()}</span></div>
        {tokenError && <p role="alert" className="field-error">Triage could not renew its access to GitHub: {tokenError}. Check that the App is still installed on GitHub and that its key is current; if not, replace the key.</p>}
        {editing && (
          <form className="rline" onSubmit={save}>
            <Input className="val" inputMode="numeric" aria-label="App ID" placeholder="App ID" value={appId} onChange={(event) => setAppId(event.target.value)} disabled={disabled} autoComplete="off" />
            <textarea className="val w" aria-label="Private key" placeholder="Private key" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} disabled={disabled} autoComplete="off" />
            <Button type="submit" size="sm" disabled={disabled || !appId.trim() || !privateKey.trim()}>{replace.isPending ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={cancel}>Cancel</Button>
          </form>
        )}
        {replace.error && <p role="alert" className="field-error">Could not replace the {name} key. {errorText(replace.error)}</p>}
        {removal.error && <p role="alert" className="field-error">Could not remove {name}. {errorText(removal.error)} Try again.</p>}
      </div>
      {replaceable && !editing && <Button type="button" variant="outline" size="sm" aria-label={`Replace ${name} key`} disabled={disabled} onClick={() => setEditing(true)}>Replace key</Button>}
      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => removal.mutate()}>Remove</Button>
    </div>
  );
}
