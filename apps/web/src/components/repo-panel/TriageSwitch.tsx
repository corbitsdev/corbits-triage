import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { usePortal } from "../../lib/portal.tsx";
import type { RepoPack } from "../../lib/repo-pack.ts";

type TriageSwitchProps = {
  repo: string;
  enabled: boolean;
  triaging: boolean;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Whether a rule is switched on; triage runs without one, but triggers nothing. */
  ruleOn: boolean;
  /** Whether the policy has a judgement rule. With no saved model, the switch says so. */
  needsModel: boolean;
  /** Whether open pull requests can be triaged again; the backlog route takes GitHub repositories only. */
  rerunnable: boolean;
};

function ModelGap({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="help" role="status">
      This policy needs a model before its judgement rules can run. <Link to="/settings/triage">Add one in Settings</Link>.
    </p>
  );
}

export default function TriageSwitch({ repo, enabled, triaging, disabled, edit, ruleOn, needsModel, rerunnable }: TriageSwitchProps) {
  const { snapshot, runBacklog } = usePortal();
  const [rerunError, setRerunError] = useState("");
  const switchId = useId();

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

  function hint() {
    if (!enabled) return <span className="gate-note">Turn on triage to run this repository's policy</span>;
    if (!triaging || !rerunnable || !ruleOn) return null;
    return <button type="button" className="linkish quiet" disabled={disabled} onClick={() => void triageAgain()}>Triage open pull requests again</button>;
  }

  return (
    <>
      <div className="switch-card" id="rp-triage">
        <div className="sc-t">
          <label htmlFor={switchId}>Triage pull requests in this repository</label>
          {hint()}
        </div>
        <Switch id={switchId} className="sw lg" checked={enabled} onCheckedChange={setEnabled} label="Triage pull requests in this repository" disabled={disabled} />
      </div>
      <ModelGap show={needsModel && snapshot?.decisionModel === undefined} />
      {triaging && !ruleOn ? <p className="help" role="status">Triage is on. It starts once the policy has a rule.</p> : null}
      {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
    </>
  );
}
