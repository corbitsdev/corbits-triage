import { Badge, type BadgeTone } from "@corbits/react-ui";
import type { CodeReviewPlaceOption } from "@corbits/triage-contracts";
import { anthropicSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { isActiveCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { CopyButton } from "../CopyField.tsx";
import { ExternalIcon } from "../inbox-icons.tsx";
import { AnthropicKeyForm } from "./AnthropicKeyForm.tsx";
import { KeyRow } from "./KeyRow.tsx";

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
      {place.state === "failing" && <PlaceSetup place={place} />}
      {place.state === "not_set_up" && (
        <details className="place-steps">
          <summary>How to set it up</summary>
          <PlaceSetup place={place} />
        </details>
      )}
    </div>
  );
}

function WhereItRuns({ places }: { places: CodeReviewPlaceOption[] }) {
  return (
    <div className="gcard source" aria-labelledby="code-review-places" role="group">
      <header>
        <b id="code-review-places">Where it runs</b>
        <span>Code review never runs inside Triage itself. It runs in the first place below that is ready. When that place is full, new reviews wait there for room; they do not move to the next place.</span>
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
            editor={(onSaved) => <AnthropicKeyForm layout="row" submitLabel="Save key" onCancel={null} onSaved={onSaved} />}
          />
        </div>
        {snapshot.codeReviewPlaces && <WhereItRuns places={snapshot.codeReviewPlaces} />}
        {snapshot.codeReviewPlaceError && <p role="alert" className="error">Could not read where code review runs. {snapshot.codeReviewPlaceError}</p>}
      </div>
    </section>
  );
}
