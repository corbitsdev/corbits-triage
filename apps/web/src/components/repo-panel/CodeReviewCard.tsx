import { useId, useState } from "react";
import { Button, Switch } from "@corbits/react-ui";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { errorText } from "@corbits/common";
import { useFocusWhenEnabled } from "../../lib/focus-when-enabled.ts";
import { codeReviewProvider, type RepoRecord } from "../../lib/hub-api.ts";
import { usePortal } from "../../lib/portal.tsx";
import { KeyPopup } from "../KeyPopup.tsx";
import { ANTHROPIC_KEY_SAVE, AnthropicKeyForm } from "../settings/AnthropicKeyForm.tsx";

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
  const [askingForKey, setAskingForKey] = useState(false);
  const switchId = useId();
  const keyStored = snapshot !== null && codeReviewProvider(snapshot.credentials) !== undefined;
  const keysDenied = !keyStored && snapshot?.denied.credentials === true;
  const keysUnreadable = keyStored ? undefined : snapshot?.credentialsError;
  const { focusSoon, afterRender } = useFocusWhenEnabled(switchId);
  // A key stored elsewhere closes the popup; forgetting the ask keeps it from coming back if that key is removed later.
  if (askingForKey && keyStored) setAskingForKey(false);
  const change = useMutation({
    mutationFn: function applySwitch(next: boolean) {
      return switchCodeReview(repo, next);
    },
  });
  const on = change.isPending ? change.variables : repo.codeReview === true;

  function flip(next: boolean) {
    if (next && !keyStored) setAskingForKey(true);
    else change.mutate(next);
  }

  function stopAsking() {
    setAskingForKey(false);
  }

  function turnOnWithKey() {
    setAskingForKey(false);
    change.mutate(true);
  }

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
          <div className={`sentence${on ? "" : " off"}`} ref={afterRender}>
            <span className="txt">{SENTENCE}</span>
            <Switch id={switchId} className="sw" checked={on} onCheckedChange={flip} label={SENTENCE} disabled={disabled || change.isPending || (!on && (keysDenied || keysUnreadable !== undefined))} />
          </div>
        </div>
      </div>
      <KeyPopup
        open={askingForKey}
        title="Code review needs an Anthropic key"
        description="Anthropic reads each new commit for bugs. The key is saved for the whole workspace, so other repositories can use it too."
        mutationKey={ANTHROPIC_KEY_SAVE}
        onCancel={stopAsking}
        returnFocus={focusSoon}
      >
        <AnthropicKeyForm layout="popup" submitLabel="Save and turn on" onCancel={stopAsking} onSaved={turnOnWithKey} />
      </KeyPopup>
      {keysDenied ? <p className="help">Code review needs an Anthropic key, and only a workspace owner can add one. Ask an owner to add it in Settings → Code review.</p> : null}
      {keysUnreadable === undefined ? null : <p role="alert" className="error">Could not read the workspace's keys. {keysUnreadable}</p>}
      {change.error ? <p role="alert" className="error">Could not change code review. {errorText(change.error)}</p> : null}
    </section>
  );
}
