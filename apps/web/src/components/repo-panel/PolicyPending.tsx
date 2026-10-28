import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { RepoSource } from "@corbits/triage-contracts";
import { usePolicyStrip } from "../../lib/policy-upgrades.ts";
import { ExternalIcon } from "../inbox-icons.tsx";
import { HOST_NAME } from "./PolicyStart.tsx";

type PolicyPendingProps = { repo: string; source: RepoSource; pending: string; disabled: boolean };

/** What the policy file holds that Triage skips, and the pull request that removes it. */
export default function PolicyPending({ repo, source, pending, disabled }: PolicyPendingProps) {
  const strip = usePolicyStrip(repo, source);
  const done = strip.data;
  const lines = pending.split("\n");
  const one = lines.length === 1;

  function actions() {
    if (done === undefined) return <div className="acts"><Button type="button" size="sm" disabled={disabled || strip.isPending} onClick={() => strip.mutate()}>Create pull request to remove {one ? "it" : "them"}</Button></div>;
    if (!("url" in done)) return <p className="lead">The open policy pull request already removes {one ? "it" : "them"}; merge it to finish.</p>;
    return (
      <div className="sentence pr-row">
        <span className="txt">Pull request #{done.number}</span>
        <Button asChild variant="ghost" size="sm"><a href={done.url} target="_blank" rel="noreferrer">Review on {HOST_NAME[source]} <ExternalIcon /></a></Button>
      </div>
    );
  }

  return (
    <div className="gcard">
      <div className="sentences">
        <div className="sentence"><span className="txt">Triage runs the rest of the file and skips {one ? "this" : "these"}:</span></div>
        {lines.map((line) => <p key={line} className="reason">{line}</p>)}
        {actions()}
      </div>
      {strip.error ? <p role="alert" className="error">{errorText(strip.error)}</p> : null}
    </div>
  );
}
