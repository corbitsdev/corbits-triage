import { Button, ConfirmButton } from "@corbits/react-ui";
import { Check, ExternalLink } from "lucide-react";
import { useState } from "react";
import { errorText } from "../error-text.ts";
import { githubHref } from "../github-href.ts";
import { tellTab } from "../messages.ts";
import { pageActions, type PageAction } from "../page-actions.ts";
import { actionKey, appliedActions, liveApplied } from "../storage.ts";
import type { TriageView } from "../view.ts";
import { useStorageItem } from "./use-storage.ts";

// A comment past this many characters opens collapsed to its first lines.
const LONG_BODY = 220;

const APPLY_LABELS: Record<PageAction["kind"], string> = {
  labels: "Add the label",
  assign: "Assign the pull request",
  "request-review": "Request the review",
  comment: "Post comment",
  close: "Close this pull request",
  "edit-body": "Edit the description",
  link: "Open on GitHub",
  ready: "Mark it ready for review",
};

// These only open or fill one of GitHub's editors, so they can be applied again.
const REPEATABLE = new Set<PageAction["kind"]>(["comment", "edit-body", "link"]);

/** Without `tabId`, no GitHub tab shows the pull request, so nothing can be applied until one does. */
function ActionRow({ action, view, tabId, primary }: { action: PageAction; view: TriageView; tabId: number | undefined; primary: boolean }) {
  const applied = liveApplied(useStorageItem(appliedActions)?.[actionKey(view.pr, action.id)]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const long = (action.body?.length ?? 0) > LONG_BODY;
  const posted = applied?.state === "done" && applied.post === true;
  const done = applied?.state === "done" && !REPEATABLE.has(action.kind);

  async function send(post: boolean) {
    setError(null);
    if (tabId === undefined) return;
    try {
      await tellTab(tabId, { type: "apply-action", pr: view.pr, action, post });
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function apply() {
    send(false);
  }

  function post() {
    send(true);
  }

  function toggle() {
    setExpanded(!expanded);
  }

  const variant = primary && !done ? "primary" : "outline";
  const busy = applied?.state === "applying" || tabId === undefined;
  const failure = error ?? (applied?.state === "failed" ? applied.error ?? null : null);
  return (
    <li className="action-row">
      <div className="action-head">
        <div className="action-text">
          <b>{action.title}</b>
          <span className="hint">{action.why}</span>
        </div>
        {action.kind === "comment"
          ? null
          : action.kind === "close"
            ? <ConfirmButton size="sm" variant="outline" disabled={busy || done} confirmLabel="Confirm: close this pull request" onConfirm={apply}>{done ? "Closed" : APPLY_LABELS.close}</ConfirmButton>
            : action.kind === "link"
              ? <Button asChild size="sm" variant="outline"><a href={githubHref(action.href)} target="_blank" rel="noreferrer">{APPLY_LABELS.link}<ExternalLink aria-hidden="true" /></a></Button>
              : <Button size="sm" variant={variant} disabled={busy || done} onClick={apply}>{done ? <><Check aria-hidden="true" />Done</> : APPLY_LABELS[action.kind]}</Button>}
      </div>
      {action.body ? <blockquote className="draft-body" data-clamped={long && !expanded}>{action.body}</blockquote> : null}
      {long ? <button type="button" className="text-button" aria-expanded={expanded} onClick={toggle}>{expanded ? "Show less" : "Show all"}</button> : null}
      {action.kind === "comment" && !posted
        ? <div className="row">
            <Button size="sm" variant="primary" disabled={busy} onClick={post}>{applied?.state === "applying" && applied.post ? "Posting…" : APPLY_LABELS.comment}</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={apply}>Edit first</Button>
          </div>
        : null}
      {applied?.state === "done" && action.kind === "comment" ? <p className="done-note" role="status"><Check aria-hidden="true" />{posted ? "Posted on the pull request" : "In the comment box"}</p> : null}
      {applied?.state === "done" && action.kind === "edit-body" ? <p className="done-note" role="status"><Check aria-hidden="true" />Added to the description editor</p> : null}
      {failure ? <p className="error" role="alert">{failure}</p> : null}
    </li>
  );
}

export function ActionList({ view, tabId, primary }: { view: TriageView; tabId: number | undefined; primary: boolean }) {
  const actions = pageActions(view);
  if (!actions.length) return null;
  // A link only opens GitHub's page, so the view's one primary action is the first that does something here.
  const lead = actions.find((action) => action.kind !== "link");
  return <ul className="actions-list">{actions.map((action) => <ActionRow key={action.id} action={action} view={view} tabId={tabId} primary={primary && action === lead} />)}</ul>;
}
