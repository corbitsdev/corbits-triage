import { useId, useState } from "react";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { useFocusWhenEnabled } from "../../lib/focus-when-enabled.ts";
import { usePortal } from "../../lib/portal.tsx";
import type { RepoPack } from "../../lib/repo-pack.ts";
import { DECISION_MODEL_SAVE, DecisionModelForm } from "../DecisionModelForm.tsx";
import { KeyPopup } from "../KeyPopup.tsx";

type TriageSwitchProps = {
  repo: string;
  enabled: boolean;
  triaging: boolean;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Whether a rule is switched on; triage runs without one, but triggers nothing. */
  ruleOn: boolean;
  /** Whether open pull requests can be triaged again; the backlog route takes GitHub repositories only. */
  rerunnable: boolean;
};

export default function TriageSwitch({ repo, enabled, triaging, disabled, edit, ruleOn, rerunnable }: TriageSwitchProps) {
  const { snapshot, runBacklog } = usePortal();
  const [rerunError, setRerunError] = useState("");
  const [askingForModel, setAskingForModel] = useState(false);
  const switchId = useId();
  const { focusSoon, afterRender } = useFocusWhenEnabled(switchId);

  async function triageAgain() {
    setRerunError("");
    try {
      await runBacklog(repo, "Triaging open pull requests again.");
    } catch (cause) {
      setRerunError(`Could not triage again. ${errorText(cause)}`);
    }
  }

  function setEnabled(next: boolean) {
    edit((current) => ({ ...current, policy: { ...current.policy, enabled: next } }));
  }

  function flip(next: boolean) {
    if (next && snapshot?.decisionModel === undefined) setAskingForModel(true);
    else setEnabled(next);
  }

  function stopAsking() {
    setAskingForModel(false);
  }

  function turnOnWithModel() {
    setAskingForModel(false);
    setEnabled(true);
  }

  function hint() {
    if (!enabled) return <span className="gate-note">Turn on triage to run this repository's policy</span>;
    if (!triaging || !rerunnable) return null;
    return <button type="button" className="linkish quiet" disabled={disabled} onClick={() => void triageAgain()}>Triage open pull requests again</button>;
  }

  return (
    <>
      <div className="switch-card" id="rp-triage" ref={afterRender}>
        <div className="sc-t">
          <label htmlFor={switchId}>Triage pull requests in this repository</label>
          {hint()}
        </div>
        <Switch id={switchId} className="sw lg" checked={enabled} onCheckedChange={flip} label="Triage pull requests in this repository" disabled={disabled} />
      </div>
      <KeyPopup
        open={askingForModel}
        title="Triage needs a decision model"
        description="It judges each pull request against your policy. It is saved for the whole workspace, so other repositories can use it too."
        mutationKey={DECISION_MODEL_SAVE}
        onCancel={stopAsking}
        returnFocus={focusSoon}
      >
        <DecisionModelForm submitLabel="Save and turn on" onCancel={stopAsking} onSaved={turnOnWithModel} />
      </KeyPopup>
      {triaging && !ruleOn ? <p className="help" role="status">Triage is on. It starts once the policy has a rule.</p> : null}
      {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
    </>
  );
}
