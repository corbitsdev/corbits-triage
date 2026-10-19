import { useState, type FormEvent } from "react";
import { Badge, Button, Input, type BadgeTone } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { errorText } from "@corbits/common";
import type { CodeReviewPlaceOption } from "@corbits/triage-contracts";
import { anthropicSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { isActiveCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyButton } from "../CopyField.tsx";
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

const STATE: Record<CodeReviewPlaceOption["state"], { label: string; tone: BadgeTone }> = {
  active: { label: "In use", tone: "success" },
  ready: { label: "Ready", tone: "neutral" },
  not_set_up: { label: "Not set up", tone: "neutral" },
  failing: { label: "Failing", tone: "danger" },
};

function PlaceSetup({ place }: { place: CodeReviewPlaceOption }) {
  const lines = place.env.join("\n");
  return (
    <div className="place-setup">
      {lines ? (
        <>
          <span>Add these lines to the Triage server's <code>.env</code>, then restart it:</span>
          <div className="sentence">
            <pre className="txt mono small-text">{lines}</pre>
            <CopyButton value={lines} label={`Copy the .env lines for ${place.label}`} />
          </div>
        </>
      ) : (
        <span>Nothing to add to <code>.env</code>; the setup guide has every step.</span>
      )}
      <a className="linkish" href={place.guide} target="_blank" rel="noreferrer">Setup guide <ExternalIcon /></a>
    </div>
  );
}

function Place({ place }: { place: CodeReviewPlaceOption }) {
  const state = STATE[place.state];
  return (
    <div className="place">
      <div className="sentence">
        <span className="txt">{place.label}<span className="place-why">{place.why}</span></span>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      {place.reason && <p className="field-error">{place.reason}</p>}
      {(place.state === "not_set_up" || place.state === "failing") && <PlaceSetup place={place} />}
    </div>
  );
}

function WhereItRuns({ places }: { places: CodeReviewPlaceOption[] }) {
  return (
    <div className="gcard source" aria-labelledby="code-review-places" role="group">
      <header>
        <b id="code-review-places">Where it runs</b>
        <span>Code review never runs on the Triage server itself. It runs in the first place below that is ready. When that place is full, new reviews wait there for room; they do not move to the next place.</span>
      </header>
      <div className="sentences">
        {places.map((place) => <Place key={place.id} place={place} />)}
      </div>
    </div>
  );
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
        </div>
        {snapshot.codeReviewPlaces && <WhereItRuns places={snapshot.codeReviewPlaces} />}
      </div>
    </section>
  );
}
