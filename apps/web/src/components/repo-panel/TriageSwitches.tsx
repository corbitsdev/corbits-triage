import { useState } from "react";
import { Switch } from "@corbits/react-ui";
import { errorText } from "../../lib/error-text.ts";
import type { DraftPolicy } from "../../lib/pack-draft.ts";
import { usePortal } from "../../lib/portal.tsx";
import type { RepoPack } from "../../lib/repo-pack.ts";

type TriageSwitchesProps = {
  repo: string;
  policy: DraftPolicy;
  /** Triage is on as saved, so open pull requests can be triaged again. */
  triaging: boolean;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Why the draft cannot be saved, when the triage switch is the reason. */
  reason?: string;
};

/** Whether triage runs on the repository. */
export default function TriageSwitches({ repo, policy, triaging, disabled, edit, reason }: TriageSwitchesProps) {
  const { runBacklog } = usePortal();
  const [rerunError, setRerunError] = useState("");

  function setPolicy(patch: Partial<DraftPolicy>) {
    edit((current) => ({ ...current, policy: { ...current.policy, ...patch } }));
  }

  async function triageAgain() {
    setRerunError("");
    try {
      await runBacklog(repo, "Triaging open pull requests again.");
    } catch (cause) {
      setRerunError(`Could not triage again. ${errorText(cause)}`);
    }
  }

  return (
    <section className="rs" aria-labelledby="rs-triage">
      <h3 id="rs-triage">Triage</h3>
      <div className="sentences">
        <div className={reason ? "sentence invalid" : "sentence"} id="rp-triage">
          <span className="txt">Triage pull requests in this repository
            {triaging ? <small><button type="button" className="linkish" disabled={disabled} onClick={() => void triageAgain()}>Triage open pull requests again</button></small> : <small>Nothing runs until triage is on.</small>}
          </span>
          <Switch className="sw" checked={policy.enabled} onCheckedChange={(enabled) => setPolicy({ enabled })} label="Triage pull requests in this repository" disabled={disabled} />
        </div>
        {reason ? <p className="reason">{reason}</p> : null}
        {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
      </div>
    </section>
  );
}
