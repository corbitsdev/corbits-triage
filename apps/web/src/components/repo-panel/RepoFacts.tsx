import { useState } from "react";
import { Switch } from "@corbits/react-ui";
import { errorText } from "../../lib/error-text.ts";
import type { DraftPolicy } from "../../lib/pack-draft.ts";
import { usePortal } from "../../lib/portal.tsx";
import type { RepoPack } from "../../lib/repo-pack.ts";
import type { RepoRow } from "../../lib/repo-rows.ts";
import { relativeTime } from "../../lib/triage-view.ts";
import HealthMark from "./HealthMark.tsx";

type RepoFactsProps = {
  repo: string;
  row: RepoRow;
  /** The pull request counts are current. */
  live: boolean;
  policy: DraftPolicy;
  /** Triage is on as saved, so open pull requests can be triaged again. */
  triaging: boolean;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Why the draft cannot be saved, when the triage switch is the reason. */
  reason?: string;
};

function Byline({ row }: { row: RepoRow }) {
  if ("error" in row.pulls) return <div className="byline"><span title={row.pulls.error}>Could not read pull requests from GitHub</span></div>;
  const { open, needsYou, lastActivity } = row.pulls;
  return (
    <div className="byline">
      <span>{open} open</span>
      <span>{needsYou} need you</span>
      <span>{lastActivity ? `last activity ${relativeTime(lastActivity)}` : "no activity yet"}</span>
      <span><HealthMark health={row.health} /></span>
    </div>
  );
}

/** What the repository looks like now, and whether triage runs on it. */
export default function RepoFacts({ repo, row, live, policy, triaging, disabled, edit, reason }: RepoFactsProps) {
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
    <>
      {live ? <Byline row={row} /> : null}
      <section className="rs" aria-labelledby="rs-triage">
        <div className={reason ? "sentence invalid" : "sentence"} id="rp-triage">
          <span className="txt">Triage pull requests in this repository
            {triaging ? <small><button type="button" className="linkish" disabled={disabled} onClick={() => void triageAgain()}>Triage open pull requests again</button></small> : <small>Nothing runs until triage is on.</small>}
          </span>
          <Switch className="sw" checked={policy.enabled} onCheckedChange={(enabled) => setPolicy({ enabled })} label="Triage pull requests in this repository" disabled={disabled} />
        </div>
        {reason ? <p className="reason">{reason}</p> : null}
        {rerunError ? <p role="alert" className="error">{rerunError}</p> : null}
        <div className="sentence">
          <span className="txt">Triage pull requests while they are drafts<small>Drafts are never shown as ready. Off, they wait until marked ready.</small></span>
          <Switch className="sw" checked={policy.triageDrafts} onCheckedChange={(triageDrafts) => setPolicy({ triageDrafts })} label="Triage pull requests while they are drafts" disabled={disabled} />
        </div>
      </section>
    </>
  );
}
