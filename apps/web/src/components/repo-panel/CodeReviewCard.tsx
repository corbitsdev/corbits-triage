import { Button, Switch } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorText } from "@corbits/common";
import { codeReviewProvider, type RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";

const SENTENCE = "Review the code in every pull request for bugs";

type NeedsPlaceProps = { switchedOn: boolean; busy: boolean; turnOff: () => void };

function NeedsPlace({ switchedOn, busy, turnOff }: NeedsPlaceProps) {
  return (
    <section className="move" aria-labelledby="review-place-title">
      <header>
        <b id="review-place-title">Code review needs an isolated place to run</b>
        <span>{switchedOn ? "It is switched on here but not running. " : ""}Each review runs apart from everything else, and this server has no such place set up yet.</span>
      </header>
      <div className="acts">
        <Button asChild size="sm"><Link to="/settings/code-review">Set one up</Link></Button>
        {switchedOn ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={turnOff}>Turn off</Button> : null}
      </div>
    </section>
  );
}

export default function CodeReviewCard({ repo, disabled }: { repo: RepoRecord; disabled: boolean }) {
  const { snapshot, switchCodeReview } = usePortal();
  const keyStored = snapshot !== null && codeReviewProvider(snapshot.credentials) !== undefined;
  const change = useMutation({
    mutationFn: function applySwitch(next: boolean) {
      return switchCodeReview(repo, next);
    },
  });
  const on = change.isPending ? change.variables : repo.codeReview === true;

  if (snapshot?.codeReviewPlace === undefined) return null;
  if (snapshot.codeReviewPlace === null) {
    return (
      <section className="rs review" aria-labelledby="rs-review" id="rp-review">
        <h3 id="rs-review">Code review</h3>
        <NeedsPlace switchedOn={repo.codeReview === true} busy={disabled || change.isPending} turnOff={() => change.mutate(false)} />
        {change.error ? <p role="alert" className="error">Could not change code review. {errorText(change.error)}</p> : null}
      </section>
    );
  }

  return (
    <section className="rs review" aria-labelledby="rs-review" id="rp-review">
      <h3 id="rs-review">Code review</h3>
      <div className="gcard">
        <div className="sentences">
          <div className={`sentence${on ? "" : " off"}`}>
            <span className="txt">{SENTENCE}</span>
            <Switch className="sw" checked={on} onCheckedChange={(next) => change.mutate(next)} label={SENTENCE} disabled={disabled || change.isPending || (!keyStored && !on)} />
          </div>
        </div>
      </div>
      {keyStored ? null : <p className="help">Needs an Anthropic key in <Link to="/settings/code-review">Settings → Code review</Link>.</p>}
      {change.error ? <p role="alert" className="error">Could not change code review. {errorText(change.error)}</p> : null}
    </section>
  );
}
