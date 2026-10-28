import type { ReactNode } from "react";
import { presetFor } from "@corbits/triage-contracts";
import { modelSecrets } from "../../lib/credential-actions.ts";
import { DeniedNotice } from "../../lib/denied.tsx";
import { isActiveCredential, type PortalSnapshot } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { DecisionModelForm } from "../DecisionModelForm.tsx";
import { KeyRow } from "../settings/KeyRow.tsx";

/** A preset by its name; your own provider by its endpoint and model. */
function judgeModel(saved: { endpoint: string; model: string }): ReactNode {
  const preset = presetFor(saved);
  if (preset.id !== "custom") return <b>{preset.label}</b>;
  return <><b>{saved.endpoint}</b> · <span className="mono small-text">{saved.model}</span></>;
}

/** The decision model every repository's judging rules use, set once for the workspace. */
export function DecisionModelSection({ snapshot }: { snapshot: PortalSnapshot }) {
  const { removeDecisionModel } = usePortal();
  const saved = snapshot.decisionModel;
  const words = saved ? <>Judge pull requests with {judgeModel(saved)}</> : "Judge pull requests with a decision model";

  return (
    <section className="sec" id="decision-model" aria-labelledby="sec-decision-model">
      <header>
        <h2 id="sec-decision-model">Judging</h2>
        <p>Answers every repository's judging rules and chooses the verdict.</p>
      </header>
      <div>
        {snapshot.denied.credentials && <DeniedNotice section="credentials" />}
        <div className="sentences">
          <KeyRow
            words={words}
            name="decision model"
            keys={modelSecrets(snapshot.credentials).filter(isActiveCredential)}
            denied={snapshot.denied.credentials}
            remove={removeDecisionModel}
            error={snapshot.credentialsError}
            editor={(onSaved) => <DecisionModelForm onSaved={onSaved} />}
          />
        </div>
      </div>
    </section>
  );
}
