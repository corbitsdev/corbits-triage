import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { presetFor } from "@corbits/triage-contracts";
import { DOCKER_GUIDE } from "../../lib/code-review-place.ts";
import { anthropicSecrets, modelSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import type { HubCredential, PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { DecisionModelForm } from "../DecisionModelForm.tsx";
import { ExternalIcon } from "../inbox-icons.tsx";

/** A preset by its name; your own provider by its endpoint and model. */
function judgeModel(saved: { endpoint: string; model: string }): ReactNode {
  const preset = presetFor(saved);
  if (preset.id !== "custom") return <b>{preset.label}</b>;
  return <><b>{saved.endpoint}</b> · <span className="mono small-text">{saved.model}</span></>;
}

function AnthropicKeyForm({ onSaved }: { onSaved: () => void }) {
  const { saveAnthropic, readOnly } = usePortal();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: saveAnthropic,
    onSuccess: function clearKey() {
      setKey("");
      onSaved();
    },
  });
  const disabled = readOnly || save.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(key);
  }

  return (
    <form className="sentence" aria-label="Anthropic key" onSubmit={submit}>
      <div className="rmain">
        <label className="rline">
          <span className="w">Anthropic key</span>
          <Input className="val w" type="password" placeholder="sk-ant-…" value={key} onChange={(event) => setKey(event.target.value)} disabled={disabled} autoComplete="off" />
        </label>
        {save.error && <p role="alert" className="field-error">Could not save the Anthropic key. {errorText(save.error)}</p>}
      </div>
      <Button type="submit" size="sm" disabled={disabled || !key.trim()}>{save.isPending ? "Saving…" : "Save key"}</Button>
    </form>
  );
}

type KeyRowProps = {
  words: ReactNode;
  name: string;
  keys: HubCredential[];
  denied: boolean;
  remove: (credentialId: string) => Promise<void>;
  editor: (onSaved: () => void) => ReactNode;
};

/** One model and its key: stored keys can be changed or removed; without one, its form is open. Without access to credentials, only the sentence shows. */
function KeyRow({ words, name, keys, denied, remove, editor }: KeyRowProps) {
  const { readOnly } = usePortal();
  const [editing, setEditing] = useState(false);
  const removal = useMutation({
    mutationFn: async function removeKeys() {
      if (!window.confirm(`Remove the ${name} key? What uses it stops working.`)) return;
      for (const key of keys) await remove(key.id);
    },
  });
  const stored = keys.length > 0;

  if (denied) return <div className="sentence"><span className="txt">{words}</span></div>;

  return (
    <>
      <div className="sentence">
        <span className="txt">{words}</span>
        <span className="key-acts">
          <span className="model">{stored ? "Key stored" : "No key"}</span>
          {stored && <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Change"}</Button>}
          {stored && <Button type="button" variant="ghost" size="sm" disabled={readOnly || removal.isPending} onClick={() => removal.mutate()}>Remove</Button>}
        </span>
      </div>
      {(!stored || editing) && editor(() => setEditing(false))}
      {removal.error && <p role="alert" className="field-error">Could not remove the {name} key. {errorText(removal.error)}</p>}
    </>
  );
}

function ReviewPlace({ provisioner }: { provisioner: string | null | undefined }) {
  if (provisioner === undefined) return null;
  if (provisioner === null) {
    return (
      <div className="sentence">
        <span className="txt">Code review can't run yet: this server has no isolated place for it.</span>
        <Button asChild variant="outline" size="sm"><a href={DOCKER_GUIDE} target="_blank" rel="noreferrer">Set up Docker <ExternalIcon /></a></Button>
      </div>
    );
  }
  const where = provisioner === "docker" ? "a Docker container on your Triage server" : "an isolated place";
  return <div className="sentence"><span className="txt">Code review runs in {where}.</span></div>;
}

function active(credential: HubCredential): boolean {
  return credential.status.toLowerCase() === "active";
}

export function ModelsSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const { revoke, removeAnthropic } = usePortal();
  const saved = snapshot.config?.inference;

  return (
    <section className="sec" id="models" aria-labelledby="sec-models">
      <header>
        <h2 id="sec-models">Models</h2>
        <p>The keys Triage uses to judge and review pull requests.</p>
      </header>
      <div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          <KeyRow
            words={saved ? <>Judge pull requests with {judgeModel(saved)}</> : "Judge pull requests with a decision model"}
            name="decision model"
            keys={modelSecrets(snapshot.credentials).filter(active)}
            denied={snapshot.denied.credentials}
            remove={revoke}
            editor={(onSaved) => <DecisionModelForm onSaved={onSaved} />}
          />
          <KeyRow
            words={<>Review code with <b>Anthropic</b></>}
            name="Anthropic"
            keys={anthropicSecrets(snapshot.credentials).filter(active)}
            denied={snapshot.denied.credentials}
            remove={removeAnthropic}
            editor={(onSaved) => <AnthropicKeyForm onSaved={onSaved} />}
          />
          <ReviewPlace provisioner={snapshot.codeReviewPlace} />
        </div>
      </div>
    </section>
  );
}
