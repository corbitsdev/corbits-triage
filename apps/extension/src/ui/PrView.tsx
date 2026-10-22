import { Skeleton } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import type { PrRef } from "../pr.ts";
import type { RunState } from "../storage.ts";
import { nextStep, readinessOf, stateName, type TriageView } from "../view.ts";
import { CheckList } from "./CheckList.tsx";
import { ScoreRing } from "./ScoreRing.tsx";

function PrIdentity({ pr, title }: { pr: PrRef; title: string }) {
  return (
    <div className="pr-id">
      <h1 tabIndex={-1} title={title}>{title || `Pull request #${pr.number}`}</h1>
      <p className="mono pr-ref"><span className="pr-repo">{pr.repo}</span><span className="pr-number">#{pr.number}</span></p>
    </div>
  );
}

function ScoreCard({ view }: { view: TriageView }) {
  return (
    <section className="score-card" aria-label="Score">
      <ScoreRing value={readinessOf(view)} />
      <div className="score-text">
        <p className="state">{stateName(view)}</p>
        <p className="next">{nextStep(view)}</p>
      </div>
    </section>
  );
}

function RunFailed({ view, state }: { view: TriageView | undefined; state: RunState }) {
  return (
    <section className="alert" aria-labelledby="run-failed">
      <h2 id="run-failed"><CircleAlert aria-hidden="true" />{view ? "Could not refresh" : "Could not run"}</h2>
      <p role="alert">{state.error}</p>
    </section>
  );
}

/** The policy file and what it does on each verdict. */
function PolicyPart({ view }: { view: TriageView }) {
  if (!view.policy) return <p className="hint">This repository has no policy file on its default branch, so there is nothing to check.</p>;
  return (
    <section className="part" aria-labelledby="policy-head">
      <h2 id="policy-head">Policy</h2>
      <p className="hint"><a href={view.policy.url} target="_blank" rel="noreferrer">{view.policy.path}</a> on the default branch</p>
      <dl className="facts">
        {view.plans.map((plan) => <div key={plan.verdict}><dt>{plan.when}</dt><dd>{plan.steps.length ? plan.steps.join(", then ") : "do nothing"}</dd></div>)}
      </dl>
    </section>
  );
}

type PrViewProps = { pr: PrRef; title: string; view: TriageView | undefined; state: RunState | undefined };

export function PrView({ pr, title, view, state }: PrViewProps) {
  return (
    <>
      <PrIdentity pr={pr} title={title} />
      {state?.error ? <RunFailed view={view} state={state} /> : null}
      {!view && !state?.error ? (
        <div className="loading" role="status" aria-label="Checking the pull request">
          <Skeleton className="skeleton score" />
          <Skeleton className="skeleton list" />
        </div>
      ) : null}
      {view ? (
        <>
          <ScoreCard view={view} />
          {view.policy && view.paused === undefined ? (
            <section className="part" aria-labelledby="checks-head">
              <h2 id="checks-head">Checks</h2>
              <CheckList view={view} />
            </section>
          ) : null}
          <PolicyPart view={view} />
        </>
      ) : null}
    </>
  );
}
