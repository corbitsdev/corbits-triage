import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import type { PageAction } from "../page-actions.ts";
import { prKey } from "../pr.ts";
import type { Applied } from "../storage.ts";
import { shownChecks } from "../summary.ts";
import { nextStep, stateName, toneOf, type TriageView } from "../view.ts";

export type BarPlace = "banner" | "top-bar" | "title";

export type BarState = { view: TriageView; actions: PageAction[]; applied: Record<string, Applied | undefined> };

export type ActionBar = { element: HTMLElement; render(state: BarState | undefined): void };

// A close is final, so its first click asks again; the question stands this long.
const CONFIRM_MS = 4000;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

function brand(): HTMLElement {
  const label = node("span", "bar-brand");
  label.innerHTML = `<svg viewBox="32 115 437 270" aria-hidden="true"><path fill="currentColor" d="${CORBITS_MARK_PATH}"/></svg>`;
  label.append(node("span", "bar-brand-name", "Corbits Triage"));
  return label;
}

export type BarHandlers = { apply(action: PageAction): void; post(action: PageAction): void };

/**
 * The pull request's triage on GitHub's page, on every pull request: its summary, then its suggested actions as buttons
 * when it has some. A click applies one as the signed-in person; a comment is posted, or put in the comment box to edit
 * first, and a close asks for a second click.
 */
export function actionBar(place: BarPlace, handlers: BarHandlers): ActionBar {
  const element = node("div", `bar bar-${place}`);
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Corbits Triage actions");
  let confirming: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let dismissed = false;
  let shownFor: string | undefined;
  let last: BarState | undefined;

  function confirmOrApply(action: PageAction) {
    if (action.kind !== "close" || confirming?.id === action.id) {
      clearTimeout(confirming?.timer);
      confirming = undefined;
      handlers.apply(action);
      return;
    }
    confirming = { id: action.id, timer: setTimeout(function forget() {
      confirming = undefined;
      render(last);
    }, CONFIRM_MS) };
    render(last);
  }

  function commentButtons(action: PageAction, applied: Applied | undefined): HTMLElement {
    const pair = node("span", "bar-pair");
    const posted = applied?.post === true && applied.state === "done";
    const busy = applied?.state === "applying";
    const post = node("button", "bar-action", posted ? `✓ Posted: ${action.title}` : busy && applied.post ? `Posting: ${action.title}…` : `Post comment: ${action.title}`);
    post.type = "button";
    post.dataset.kind = action.kind;
    post.dataset.primary = "true";
    post.dataset.state = applied?.state ?? "ready";
    post.disabled = posted || busy;
    post.title = applied?.state === "failed" ? applied.error ?? "" : action.why;
    post.addEventListener("click", () => handlers.post(action));
    pair.append(post);
    if (!posted) {
      const edit = node("button", "bar-action", "Edit first");
      edit.type = "button";
      edit.disabled = busy;
      edit.setAttribute("aria-label", `Edit first: ${action.title}`);
      edit.title = "Put it in the comment box without posting";
      edit.addEventListener("click", () => handlers.apply(action));
      pair.append(edit);
    }
    return pair;
  }

  function actionButton(action: PageAction, applied: Applied | undefined): HTMLButtonElement {
    const button = node("button", "bar-action");
    button.type = "button";
    button.dataset.kind = action.kind;
    button.dataset.state = applied?.state ?? "ready";
    const done = applied?.state === "done";
    button.textContent = confirming?.id === action.id ? "Confirm: close this pull request" : applied?.state === "applying" ? `${action.title}…` : done ? `✓ ${action.title}` : action.title;
    button.disabled = applied?.state === "applying" || done;
    button.title = applied?.state === "failed" ? applied.error ?? "" : action.why;
    button.addEventListener("click", function apply() {
      confirmOrApply(action);
    });
    return button;
  }

  function summary(view: TriageView): HTMLElement {
    const head = node("p", "bar-summary");
    head.dataset.tone = toneOf(view);
    // Beside the title the chip already shows the score and state.
    if (place !== "title") head.append(node("span", "bar-score", view.readiness?.toString() ?? "–"), node("b", "bar-state", stateName(view)));
    const shown = shownChecks(view);
    const failing = shown.filter((check) => check.result === "fail").length;
    const unsure = shown.filter((check) => check.result !== "fail" && check.result !== "pass").length;
    const counts = [failing ? `${failing} failing` : "", unsure ? `${unsure} unsure` : ""].filter(Boolean).join(" · ");
    if (counts) head.append(node("span", "bar-counts", counts));
    const next = node("span", "bar-next", nextStep(view));
    next.title = nextStep(view);
    head.append(next);
    return head;
  }

  function dismiss() {
    dismissed = true;
    render(last);
  }

  // Beside the title go the steps a click finishes; the drafts stay with the sidebar's block. A close, which cannot be
  // undone, comes last.
  function shownActions(state: BarState | undefined): PageAction[] {
    const actions = state?.actions ?? [];
    const here = place === "title" ? actions.filter((action) => action.kind !== "comment") : actions;
    return [...here.filter((action) => action.kind !== "close"), ...here.filter((action) => action.kind === "close")];
  }

  function render(state: BarState | undefined) {
    // A banner hidden on one pull request comes back on the next.
    const key = state ? prKey(state.view.pr) : undefined;
    if (key !== shownFor) dismissed = false;
    shownFor = key;
    last = state;
    const actions = shownActions(state);
    element.hidden = dismissed || !state;
    if (element.hidden || !state) {
      element.replaceChildren();
      return;
    }
    const focused = (element.getRootNode() as Document | ShadowRoot).activeElement;
    const refocus = focused instanceof HTMLButtonElement && element.contains(focused) ? [...element.querySelectorAll("button")].indexOf(focused) : -1;
    const buttons = node("div", "bar-actions");
    buttons.append(...actions.map((action) => (action.kind === "comment" ? commentButtons(action, state.applied[action.id]) : actionButton(action, state.applied[action.id]))));
    const failed = actions.map((action) => state.applied[action.id]).find((applied) => applied?.state === "failed");
    const status = node("p", "bar-status", failed?.error ?? "");
    status.setAttribute("role", "status");
    const parts: Node[] = [brand(), summary(state.view), ...(actions.length ? [buttons] : []), status];
    if (place === "banner") {
      const close = node("button", "bar-dismiss", "×");
      close.type = "button";
      close.setAttribute("aria-label", "Hide Triage on this page");
      close.addEventListener("click", dismiss);
      parts.push(close);
    }
    element.replaceChildren(...parts);
    if (refocus >= 0) element.querySelectorAll("button")[refocus]?.focus();
  }

  return { element, render };
}
