import { useState } from "react";
import { Switch } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { usePortal } from "../../lib/portal.tsx";
import type { RepoPack } from "../../lib/repo-pack.ts";

type TriageSwitchProps = {
  repo: string;
  enabled: boolean;
  /** Triage is on as saved, so open pull requests can be triaged again. */
  triaging: boolean;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Why the draft cannot be saved, when the triage switch is the reason. */
  reason?: string;
};

/** Whether triage runs on the repository; everything under it applies only while it is on. */
export default function TriageSwitch({ repo, enabled, triaging, disabled, edit, reason }: TriageSwitchProps) {
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
    edit((current) => ({ ...current, policy: { ...current.policy, enabled: next } }));
  }

  /** Off says what turning it on unlocks; on as saved offers to triage the open pull requests again. */
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
