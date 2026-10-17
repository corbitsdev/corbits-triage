import { useState } from "react";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type PolicyDifference, type PolicyUpgrade, type RepoSource } from "@corbits/triage-contracts";
import { usePolicyUpgradeActions, type PolicyUpgradeRow } from "../../lib/policy-upgrades.ts";
import { CheckIcon, ExternalIcon } from "../inbox-icons.tsx";

export const HOST_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

function stepState(index: number, at: number): "done" | "now" | undefined {
  if (index < at) return "done";
  return index === at ? "now" : undefined;
}

function Track({ at, host }: { at: number; host: string }) {
  const steps = ["Review", "Open pull request", `Merge on ${host}`, "Done"];
  function step(label: string, index: number) {
    const state = stepState(index, at);
    return <li key={label} className={state} aria-current={state === "now" ? "step" : undefined}><span className="num">{index < at ? <CheckIcon /> : index + 1}</span>{label}</li>;
  }
  return <ol className="track" aria-label="Progress">{steps.map(step)}</ol>;
}

/** Paths and numbers read as code; a rule's words read as words. */
function valueClass(value: string, changed: readonly string[]): string {
  return ["glob ro", value.includes(" ") ? "words" : "", changed.includes(value) ? "ch" : ""].filter(Boolean).join(" ");
}

function Values({ values, changed }: { values: string[]; changed: string[] }) {
  if (values.length === 0) return <span className="tokens"><span className="glob ro none">off</span></span>;
  return <span className="tokens">{values.map((value, at) => <span key={`${at}-${value}`} className={valueClass(value, changed)}>{value}</span>)}</span>;
}

/** The rule, then its saved and file values one above the other, with what only one side has marked. */
function DifferenceRow({ difference }: { difference: PolicyDifference }) {
  const { saved, file } = difference;
  const changed = [...saved.filter((value) => !file.includes(value)), ...file.filter((value) => !saved.includes(value))];
  return (
    <div className="sentence">
      <div className="rmain">
        <span className="w">{difference.rule}</span>
        <div className="vs">
          <span>Saved</span><Values values={saved} changed={changed} />
          <span>File</span><Values values={file} changed={changed} />
        </div>
      </div>
    </div>
  );
}

/** `finish`: the file holds all a file can, so what is left is switching to it. */
type Stage = "review" | "pull" | "finish";

const STAGE_STEP: Record<Stage, number> = { review: 0, pull: 2, finish: 3 };

function stageOf(upgrade: Exclude<PolicyUpgrade, { state: "ok" }>, pulled: boolean): Stage {
  if (pulled) return "pull";
  return upgrade.state === "differs" && !upgrade.fixable && !upgrade.problem ? "finish" : "review";
}

type PolicyMoveProps = { row: PolicyUpgradeRow; upgrade: Exclude<PolicyUpgrade, { state: "ok" }>; source: RepoSource; disabled: boolean; onSettled: () => void };

/** Moving a repository's saved rules into its policy file, one step at a time, until the pull request is merged. */
export default function PolicyMove({ row, upgrade, source, disabled, onSettled }: PolicyMoveProps) {
  const { propose, keepFile } = usePolicyUpgradeActions(row.repo, onSettled);
  const [confirming, setConfirming] = useState(false);
  const busy = disabled || propose.isPending || keepFile.isPending;
  const pull = propose.data ?? row.pull;
  const error = propose.error ?? keepFile.error;
  const host = HOST_NAME[source];
  const differs = upgrade.state === "differs";
  const stage = stageOf(upgrade, pull !== undefined);

  function review() {
    if (!differs) return <p className="lead">{upgrade.unexpressed.length ? "Your rules and actions move as they are, except:" : "Your rules and actions move as they are."}</p>;
    return (
      <div className="sentences">
        {upgrade.problem ? <div className="sentence"><span className="txt">Triage can't read <code>{upgrade.path}</code>: {upgrade.problem}</span></div> : null}
        {upgrade.differences.map((difference, at) => <DifferenceRow key={`${at}-${difference.rule}`} difference={difference} />)}
      </div>
    );
  }

  function consequences(): string[] {
    if (!differs) return [];
    return upgrade.problem ? ["Triage runs nothing until the file is fixed."] : upgrade.differences.map((difference) => difference.instead);
  }

  function title(): string {
    if (stage === "finish") return "Finish moving to the policy file";
    return differs ? "Your policy file differs from your saved rules" : "Move this repository's rules into a policy file";
  }

  function subtitle() {
    if (stage === "finish") return "The file holds everything it can. Your saved rules apply until you switch.";
    return differs ? "Your saved rules apply until they match." : <>They keep working here until <code>{POLICY_FILE_PATH}</code> is merged.</>;
  }

  function actions() {
    if (confirming && differs) {
      return (
        <div className="confirm" role="alert">
          {consequences().map((line, at) => <p key={`${at}-${line}`}>{line}</p>)}
          <div className="acts">
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => keepFile.mutate(upgrade.saved.id)}>Use the file</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      );
    }
    if (pull) {
      return (
        <>
          <div className="sentences">
            <div className="sentence pr-row">
              <span className="txt">Pull request #{pull.number}</span>
              <span className="state"><span className="dot" />Open, waiting for merge</span>
              <Button asChild variant="outline" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Merge on {host} <ExternalIcon /></a></Button>
            </div>
          </div>
          <div className="acts">
            <button type="button" className="linkish quiet" disabled={busy} onClick={() => propose.mutate()}>Update the pull request with your saved rules</button>
            {differs ? <button type="button" className="linkish quiet" disabled={busy} onClick={() => setConfirming(true)}>Use the file instead</button> : null}
          </div>
        </>
      );
    }
    if (stage === "finish") return <div className="acts"><Button type="button" size="sm" disabled={busy} onClick={() => setConfirming(true)}>Use the file</Button></div>;
    return (
      <div className="acts">
        {!differs || upgrade.fixable ? <Button type="button" size="sm" disabled={busy} onClick={() => propose.mutate()}>{differs ? "Update the file to match" : "Open the pull request"}</Button> : null}
        {differs ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>Use the file instead</Button> : null}
      </div>
    );
  }

  return (
    <section className="move" aria-labelledby="move-title">
      <header>
        <b id="move-title">{title()}</b>
        <span>{subtitle()}</span>
      </header>
      <Track at={STAGE_STEP[stage]} host={host} />
      {pull ? null : review()}
      {stage === "review" && upgrade.unexpressed.length ? <div className="sentences">{upgrade.unexpressed.map((line) => <div key={line} className="sentence out"><span className="txt">{line}</span></div>)}</div> : null}
      {actions()}
      {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
    </section>
  );
}
