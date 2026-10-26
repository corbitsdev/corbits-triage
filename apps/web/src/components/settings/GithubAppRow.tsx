import { useId, useState, type FormEvent } from "react";
import { Button } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { isPrivateKeyPem } from "../../lib/connect-view.ts";
import { connectGithubApp } from "../../lib/github-manifest.ts";
import { isActiveCredential, type HubCredential } from "../../lib/hub-api.ts";
import { createHubTransport } from "../../lib/hub-transport.ts";
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

async function readKey(file: File): Promise<string> {
  const contents = await file.text();
  if (!isPrivateKeyPem(contents)) throw new Error("That file is not a GitHub App private key.");
  return contents;
}

/** The GitHub App: a new key is sent alone, so the hub checks it with GitHub as the stored App's before saving it. */
export function GithubAppRow({ credential, name, tenantId, replaceable, remove }: GithubAppRowProps) {
  const { readOnly, notify } = usePortal();
  const fileId = useId();
  const [editing, setEditing] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [privateKey, setPrivateKey] = useState("");
  const [keyName, setKeyName] = useState("");
  const key = useMutation({ mutationFn: readKey });
  const replace = useMutation({
    mutationFn: function replaceKey() {
      return connectGithubApp(createHubTransport(), tenantId, { privateKey });
    },
    onSuccess: function closeEditor() {
      clear();
      setEditing(false);
      setReplaced(true);
      notify("GitHub App key replaced.");
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

  function clear() {
    setPrivateKey("");
    setKeyName("");
    key.reset();
  }

  function cancel() {
    clear();
    setEditing(false);
  }

  function startReplacing() {
    setReplaced(false);
    setEditing(true);
  }

  function chooseKey(file: File | undefined) {
    if (!file) return;
    key.mutate(file, {
      onSuccess: function keepKey(contents) {
        setPrivateKey(contents);
        setKeyName(file.name);
      },
    });
  }

  return (
    <div className="sentence">
      <div className="rmain">
        <div className="rline"><span className="w">{name} secret</span><span className="model">{isActiveCredential(credential) ? "stored" : credential.status.toLowerCase()}</span></div>
        {tokenError && <p role="alert" className="field-error">Triage could not renew its access to GitHub: {tokenError}. Check that the App is still installed on GitHub and that its key is current; if not, replace the key.</p>}
        {editing && (
          <ol className="field-help">
            <li>In your GitHub App's settings on GitHub, generate a new private key.</li>
            <li>Choose the downloaded .pem file here and save.</li>
            <li>Then delete the old key on GitHub.</li>
          </ol>
        )}
        {editing && (
          <form className="rline" onSubmit={save}>
            <input className="sr-only" id={fileId} type="file" accept=".pem" disabled={disabled} onChange={(event) => chooseKey(event.target.files?.[0])} />
            <Button asChild variant="outline" size="sm"><label htmlFor={fileId}>{keyName || "Choose .pem file"}</label></Button>
            <Button type="submit" size="sm" disabled={disabled || !privateKey}>{replace.isPending ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={cancel}>Cancel</Button>
          </form>
        )}
        {replaced && <p role="status" className="field-help">Key replaced. Delete the old key in your GitHub App's settings on GitHub.</p>}
        {key.error && <p role="alert" className="field-error">Could not read the private key. {errorText(key.error)}</p>}
        {replace.error && <p role="alert" className="field-error">Could not replace the {name} key. {errorText(replace.error)} Try again.</p>}
        {removal.error && <p role="alert" className="field-error">Could not remove {name}. {errorText(removal.error)} Try again.</p>}
      </div>
      {replaceable && !editing && <Button type="button" variant="outline" size="sm" aria-label={`Replace ${name} key`} disabled={disabled} onClick={startReplacing}>Replace key</Button>}
      <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => removal.mutate()}>Remove</Button>
    </div>
  );
}
