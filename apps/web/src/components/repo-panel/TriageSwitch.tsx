import { useState } from "react";
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
  /** Turns triage on or off through the source's own route instead of the saved policy. */
  onToggle?: (enabled: boolean) => void;
  reason?: string;
};

export default function TriageSwitch({ repo, enabled, triaging, disabled, edit, onToggle, reason }: TriageSwitchProps) {
  const { runBacklog } = usePortal();
  const [rerunError, setRerunError] = useState("");

  async function triageAgain() {
    setRerunError("");
    try {
      await runBacklog(repo, "Triaging open pull requests again.");
    } catch (cause) {
      setRerunError(`Could not triage again. ${errorText(cause)}`);
    }
  }

  function setEnabled(next: boolean) {
    if (onToggle) {
      onToggle(next);
      return;
    }
    edit((current) => ({ ...current, policy: { ...current.policy, enabled: next } }));
  }

  function hint() {
    if (!enabled) return <span className="gate-note">Turn on triage to set rules and actions</span>;
    if (!triaging) return null;
    return <button type="button" className="linkish quiet" disabled={disabled} onClick={() => void triageAgain()}>Triage open pull requests again</button>;
  }

  return (
    <>
      <div className={reason ? "switch-card invalid" : "switch-card"} id="rp-triage">
        <div className="sc-t">
          <b>Triage pull requests in this repository</b>
          {hint()}
        </div>
        <Switch className="sw lg" checked={enabled} onCheckedChange={setEnabled} label="Triage pull requests in this repository" disabled={disabled} />
      </div>
      {reason ? <p className="reason">{reason}</p> : null}
      {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
    </>
  );
}
