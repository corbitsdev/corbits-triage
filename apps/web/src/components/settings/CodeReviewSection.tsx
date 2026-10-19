import { useState, type FormEvent } from "react";
import { Button, Input } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import { DOCKER_GUIDE } from "../../lib/code-review-place.ts";
import { anthropicSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { isActiveCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { ExternalIcon } from "../inbox-icons.tsx";
import { KeyRow } from "./KeyRow.tsx";

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

export function CodeReviewSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const { removeAnthropic } = usePortal();

  return (
    <section className="sec" id="code-review" aria-labelledby="sec-code-review">
      <header>
        <h2 id="sec-code-review">Code review</h2>
        <p>Reads each new commit of a pull request for bugs, in the repositories where it is switched on.</p>
      </header>
      <div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          <KeyRow
            words={<>Review code with <b>Anthropic</b></>}
            name="Anthropic"
            keys={anthropicSecrets(snapshot.credentials).filter(isActiveCredential)}
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
