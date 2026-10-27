import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, starterPack, type RepoSource } from "@corbits/triage-contracts";
import { usePolicyStartActions, type PolicyUpgradeRow } from "../../lib/policy-upgrades.ts";
import { CheckIcon, ExternalIcon } from "../inbox-icons.tsx";
import PolicyRules from "./PolicyRules.tsx";

export const HOST_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

function stepState(index: number, at: number): "done" | "now" | undefined {
  if (index < at) return "done";
  return index === at ? "now" : undefined;
}

function Track({ at, merge }: { at: number; merge: string }) {
  const steps = ["Review", "Create pull request", merge, "Done"];
  function step(label: string, index: number) {
    const state = stepState(index, at);
    return <li key={label} className={state} aria-current={state === "now" ? "step" : undefined}><span className="num">{index < at ? <CheckIcon /> : index + 1}</span>{label}</li>;
  }
  return <ol className="track" aria-label="Progress">{steps.map(step)}</ol>;
}

type PolicyStartProps = { repo: string; source: RepoSource; pull: PolicyUpgradeRow["pull"]; disabled: boolean };

/** Adding a policy file to a repository without one through a pull request of the starter policy, until it is merged. */
export default function PolicyStart({ repo, source, pull: listed, disabled }: PolicyStartProps) {
  const { propose, merge } = usePolicyStartActions(repo, source);
  const busy = disabled || propose.isPending || merge.isPending;
  const pull = propose.data ?? listed;
  const error = propose.error ?? merge.error;
  const host = HOST_NAME[source];

  function actions() {
    if (!pull) return <div className="acts"><Button type="button" size="sm" disabled={busy} onClick={() => propose.mutate()}>Create pull request</Button></div>;
    const { headSha } = pull;
    return (
      <div className="sentences">
        <div className="sentence pr-row">
          <span className="txt">Pull request #{pull.number}</span>
          <span className="state"><span className="dot" />Open, waiting for merge</span>
          {headSha ? (
            <>
              <Button asChild variant="ghost" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Review on {host} <ExternalIcon /></a></Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => merge.mutate({ number: pull.number, headSha })}>Merge</Button>
            </>
          ) : (
            <Button asChild variant="outline" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Merge on {host} <ExternalIcon /></a></Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <section className="move" aria-labelledby="move-title">
      <header>
        <b id="move-title">Start a policy file</b>
        <span>Triage runs nothing in this repository until <code>{POLICY_FILE_PATH}</code> is on its default branch.</span>
      </header>
      <Track at={pull ? 2 : 0} merge={source === "github" ? "Merge" : `Merge on ${host}`} />
      {pull ? null : (
        <>
          <p className="lead">The pull request adds these rules. You can change them there before you merge, or add <code>{POLICY_FILE_PATH}</code> to the default branch yourself.</p>
          <PolicyRules pack={starterPack(repo)} source={source} />
        </>
      )}
      {actions()}
      {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
    </section>
  );
}
