import { presetFor } from "@corbits/triage-contracts";
import { modelSecrets, namedSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import type { PortalSnapshot } from "../../lib/hub-api.ts";
import { DecisionModelForm } from "../DecisionModelForm.tsx";
import { CredentialRow } from "./CredentialRow.tsx";

/** A preset by its name; your own provider by its endpoint. */
function providerName(saved: { endpoint: string; model: string }): string {
  const preset = presetFor(saved);
  return preset.id === "custom" ? saved.endpoint : preset.label;
}

/** The decision model Triage asks for a verdict, its key, and the form that replaces both. */
export function ModelSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const saved = snapshot.config?.inference;
  const secrets = namedSecrets(modelSecrets(snapshot.credentials));

  return (
    <section className="sec" id="model" aria-labelledby="sec-model">
      <header>
        <h2 id="sec-model">Decision model</h2>
        <p>When no hard rule has failed, Triage asks this model which verdict a pull request gets.</p>
      </header>
      <div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          <div className="sentence">
            <span className="txt">{saved ? <>Using <b>{providerName(saved)}</b> with model <span className="mono small-text">{saved.model}</span>.</> : "No decision model is connected."}</span>
          </div>
          {secrets.map(({ credential, name }) => <CredentialRow key={credential.id} credential={credential} name={name} replaceable={false} />)}
        </div>
        <DecisionModelForm />
      </div>
    </section>
  );
}
