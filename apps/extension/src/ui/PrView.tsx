import { Button, Skeleton } from "@corbits/react-ui";
import { CircleAlert } from "lucide-react";
import { clock } from "../clock.ts";
import { send } from "../messages.ts";
import { pageActions } from "../page-actions.ts";
import type { PrRef } from "../pr.ts";
import { githubToken, type RunState } from "../storage.ts";
import { nextStep, stateName, type TriageView } from "../view.ts";
import { ActionList } from "./ActionList.tsx";
import { CheckList } from "./CheckList.tsx";
import { GithubTokenForm } from "./GithubTokenForm.tsx";
import { ScoreRing } from "./ScoreRing.tsx";
import { useStorageItem } from "./use-storage.ts";

function PrIdentity({ pr, title }: { pr: PrRef; title: string }) {
  return (
    <div className="pr-id">
      <h1 tabIndex={-1} title={title}>{title || `Pull request #${pr.number}`}</h1>
      <p className="mono pr-ref"><span className="pr-repo">{pr.repo}</span><span className="pr-number">#{pr.number}</span></p>
    </div>
  );
}

export function ScoreCard({ view }: { view: TriageView }) {
  return (
    <section className="score-card" aria-label="Score">
      <ScoreRing value={view.readiness} />
      <div className="score-text">
        <p className="state">{stateName(view)}</p>
        <p className="next">{nextStep(view)}</p>
      </div>
    </section>
  );
}

export function RunFailed({ pr, view, state }: { pr: PrRef; view: TriageView | undefined; state: RunState }) {
  const token = useStorageItem(githubToken);
  const limited = state.resetAt !== undefined;
  const moved = view !== undefined && state.head !== undefined && state.head !== view.headSha;

  function retry() {
    send({ type: "triage", pr, mode: "refetch" });
  }

  return (
    <section className="alert" aria-labelledby="run-failed">
      <h2 id="run-failed"><CircleAlert aria-hidden="true" />{moved ? "New commits not scored yet" : view ? "Could not refresh" : "Could not run"}</h2>
      <p role="alert">{state.error}</p>
      {limited && token === null ? <GithubTokenForm variant="primary" onSaved={retry} /> : null}
      {limited && token !== null ? <p className="hint">Try again after {clock(state.resetAt!)}.</p> : null}
      {limited ? null : <div className="row"><Button size="sm" variant="outline" onClick={retry}>Try again</Button></div>}
    </section>
  );
}

export function Actions({ view, tabId, primary }: { view: TriageView; tabId: number | undefined; primary: boolean }) {
  if (view.ended || !pageActions(view).length) return null;

  return (
    <section className="part" aria-labelledby="actions-head">
      <h2 id="actions-head">Actions</h2>
      <ActionList view={view} tabId={tabId} primary={primary} />
    </section>
  );
}

type PrViewProps = { pr: PrRef; title: string; tabId: number; view: TriageView | undefined; state: RunState | undefined };

export function PrView({ pr, title, tabId, view, state }: PrViewProps) {
  // A GitHub limit above holds the view's one primary action, its token form.
  const limited = state?.error !== undefined && state.resetAt !== undefined;
  return (
    <>
      <PrIdentity pr={pr} title={title} />
      {state?.error ? <RunFailed pr={pr} view={view} state={state} /> : null}
      {!view && !state?.error ? (
        <div className="loading" role="status" aria-label="Scoring the pull request">
          <Skeleton className="skeleton score" />
          <Skeleton className="skeleton list" />
        </div>
      ) : null}
      {view ? (
        <>
          <ScoreCard view={view} />
          <Actions view={view} tabId={tabId} primary={!limited} />
          <section className="part" aria-labelledby="checks-head">
            <h2 id="checks-head">Checks</h2>
            <CheckList view={view} />
          </section>
        </>
      ) : null}
    </>
  );
}
