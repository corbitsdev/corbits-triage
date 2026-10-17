import { Switch } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorText } from "@corbits/common";
import { hasAnthropicKey, type RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";

const SENTENCE = "Review the code in every pull request for bugs";

export default function CodeReviewCard({ repo, disabled }: { repo: RepoRecord; disabled: boolean }) {
  const { snapshot, switchCodeReview } = usePortal();
  const keyStored = snapshot !== null && hasAnthropicKey(snapshot.credentials);
  const change = useMutation({
    mutationFn: function applySwitch(next: boolean) {
      return switchCodeReview(repo, next);
    },
  });
  const on = change.isPending ? change.variables : repo.codeReview === true;

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
      {keyStored ? null : <p className="help">Needs an Anthropic key in <Link to="/settings/models">Settings → Models</Link>.</p>}
      {change.error ? <p role="alert" className="error">Could not change code review. {errorText(change.error)}</p> : null}
    </section>
  );
}
