import { useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { anthropicSecrets, namedSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import type { PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CredentialRow } from "./CredentialRow.tsx";

function AnthropicKeyForm() {
  const { saveAnthropic, readOnly } = usePortal();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: saveAnthropic,
    onSuccess: function clearKey() {
      setKey("");
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

export function CodeReviewSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const { removeAnthropic } = usePortal();
  const secrets = namedSecrets(anthropicSecrets(snapshot.credentials));

  return (
    <section className="sec" id="code-review" aria-labelledby="sec-code-review">
      <header>
        <h2 id="sec-code-review">Code review</h2>
        <p>Reads each pull request for bugs.</p>
      </header>
      <div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          {!snapshot.denied.credentials && secrets.length === 0 && <AnthropicKeyForm />}
          {secrets.map(({ credential, name }) => <CredentialRow key={credential.id} credential={credential} name={name} replaceable remove={removeAnthropic} />)}
        </div>
      </div>
    </section>
  );
}
