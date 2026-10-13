import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import { clock } from "../clock.ts";
import { errorText } from "../error-text.ts";
import { githubHref } from "../github-href.ts";
import type { PageAction } from "../page-actions.ts";
import type { PrRef } from "../pr.ts";
import type { Applied, RunState } from "../storage.ts";
import { checkReason, shownChecks, summaryMarkdown } from "../summary.ts";
import { nextStep, stateName, toneOf, type TriageView } from "../view.ts";
import type { SeedSpot } from "./seeds.ts";

// The block lists this many steps; the panel has the rest.
const MOST_ACTIONS = 6;
// A close is final, so its first click asks again; the question stands this long.
const CONFIRM_MS = 4000;
const RING_RADIUS = 13;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const ICONS = {
  fail: '<path d="M5 5l6 6M11 5l-6 6"/>',
  unsure: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v3M8 10.5v.5"/>',
  done: '<path d="M3.5 8.5l3 3 6-7"/>',
  link: '<path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5 7 9"/>',
  panel: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M9.5 3v10"/>',
};

function icon(name: keyof typeof ICONS): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = `<svg class="tb-icon" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  return template.content.firstElementChild as SVGSVGElement;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

/** A seed's spot, for the actions that put text in one of GitHub's fields. */
const SPOTS: Partial<Record<PageAction["kind"], SeedSpot>> = { comment: "composer", "edit-body": "body" };

export type BlockState = {
  pr: PrRef;
  view: TriageView | undefined;
  run: RunState | undefined;
  actions: PageAction[];
  applied: Record<string, Applied | undefined>;
  /** The action whose text sits in each of GitHub's fields, while it does. */
  seeded: Partial<Record<SeedSpot, string>>;
};

export type BlockHandlers = {
  apply(action: PageAction): void;
  post(action: PageAction): void;
  undo(spot: SeedSpot): void;
  openPanel(): void;
  rerun(): void;
};

export type TriageBlock = { element: HTMLElement; render(state: BlockState): void };

/**
 * Triage's section atop GitHub's pull request sidebar, on every pull request: the score and state, the next step, the
 * failing and unsure checks in a line each, and the steps to take, each applied in one click as the person signed in.
 */
export function triageBlock(handlers: BlockHandlers): TriageBlock {
  const element = node("section", "tb");
  element.setAttribute("aria-label", "Corbits Triage");
  let confirming: { id: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let last: BlockState | undefined;
  // One live region for the block's whole life, so screen readers announce what is written into it.
  const status = node("p", "tb-status");
  status.setAttribute("role", "status");
  const body = node("div", "tb-body");
  // The summary and the steps keep their nodes across renders, so the tour's spotlight stays on what it points at.
  const summary = node("div", "tb-summary");
  const steps = node("div", "tb-steps");
  element.append(body, status);

  function rerender() {
    if (last) render(last);
  }

  function head(): HTMLElement {
    const bar = node("div", "tb-head");
    const open = node("button", "tb-icon-button");
    open.type = "button";
    open.setAttribute("aria-label", "Open Triage's side panel");
    open.title = "Open the side panel";
    open.append(icon("panel"));
    open.addEventListener("click", handlers.openPanel);
    const title = node("h2", "tb-title");
    title.innerHTML = `<svg viewBox="32 115 437 270" aria-hidden="true"><path fill="currentColor" d="${CORBITS_MARK_PATH}"/></svg>`;
    title.append("Corbits Triage");
    bar.append(title, open);
    return bar;
  }

  function score(view: TriageView | undefined, run: RunState | undefined): HTMLElement {
    const box = node("div", "tb-score");
    box.dataset.tone = view ? toneOf(view) : "unknown";
    box.dataset.busy = String(run?.running === true);
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("viewBox", "0 0 32 32");
    ring.setAttribute("class", "tb-ring");
    ring.setAttribute("aria-hidden", "true");
    const filled = view?.readiness == null ? 0 : (RING_LENGTH * view.readiness) / 100;
    ring.innerHTML = `<circle class="tb-ring-track" cx="16" cy="16" r="${RING_RADIUS}"/><circle class="tb-ring-fill" cx="16" cy="16" r="${RING_RADIUS}" transform="rotate(-90 16 16)" stroke-dasharray="${filled} ${RING_LENGTH}"/>`;
    const number = node("span", "tb-number", view?.readiness?.toString() ?? (run?.running ? "…" : "–"));
    const dial = node("span", "tb-dial");
    dial.append(ring, number);
    const text = node("div", "tb-score-text");
    const state = run?.running && !view ? "Running triage" : view ? stateName(view) : run?.error ? "Could not run" : "Not triaged yet";
    text.append(node("b", "tb-state", state));
    if (view) {
      const next = node("p", "tb-next", nextStep(view));
      next.title = nextStep(view);
      text.append(next);
    }
    box.append(dial, text);
    return box;
  }

  function warning(view: TriageView | undefined, run: RunState | undefined): HTMLElement[] {
    if (run?.running && view) return [node("p", "tb-meta", "Running triage again…")];
    if (!run?.error) return [];
    const text = run.resetAt ? `GitHub's limit is used up until ${clock(run.resetAt)}.` : run.error;
    return [node("p", "tb-warn", view ? `${text} Showing the run from ${clock(view.ranAt)}.` : text)];
  }

  function checks(view: TriageView): HTMLElement[] {
    const shown = shownChecks(view);
    const open = shown.filter((check) => check.result !== "pass");
    const passed = shown.length - open.length;
    const list = node("ul", "tb-checks");
    list.setAttribute("aria-label", "Rules to look at");
    for (const check of open) {
      const item = node("li", "tb-check");
      item.dataset.result = check.result;
      const mark = node("span", "tb-mark");
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", check.result === "fail" ? "Failed" : "Not settled");
      mark.append(icon(check.result === "fail" ? "fail" : "unsure"));
      const reason = checkReason(check);
      const text = node("span", "tb-check-text");
      text.title = `${check.name}: ${reason}`;
      text.append(node("b", "", check.name), document.createTextNode(` ${reason}`));
      item.append(mark, text);
      list.append(item);
    }
    const parts: HTMLElement[] = open.length ? [list] : [];
    if (passed) parts.push(node("p", "tb-meta", open.length ? `${passed} passed` : `All ${passed} rules passed`));
    return parts;
  }

  function confirmOrApply(action: PageAction) {
    if (action.kind !== "close" || confirming?.id === action.id) {
      clearTimeout(confirming?.timer);
      confirming = undefined;
      handlers.apply(action);
      return;
    }
    confirming = { id: action.id, timer: setTimeout(function forget() {
      confirming = undefined;
      rerender();
    }, CONFIRM_MS) };
    rerender();
  }

  /** A comment: posted as the person, or put in the comment box to edit first; once posted, it says so. */
  function commentControl(action: PageAction, applied: Applied | undefined): HTMLElement {
    const box = node("div", "tb-draft");
    box.append(node("span", "tb-act-text", `Comment: ${action.title}`));
    const posted = applied?.post === true && applied.state === "done";
    const busy = applied?.state === "applying";
    const row = node("div", "tb-draft-buttons");
    const post = node("button", "tb-act", posted ? "Posted" : busy && applied.post ? "Posting…" : "Post comment");
    post.type = "button";
    post.dataset.kind = action.kind;
    post.dataset.primary = "true";
    post.dataset.state = applied?.state ?? "ready";
    post.disabled = posted || busy;
    post.setAttribute("aria-label", `${post.textContent}: ${action.title}`);
    if (posted) post.append(icon("done"));
    post.addEventListener("click", () => handlers.post(action));
    row.append(post);
    if (!posted) {
      const edit = node("button", "tb-act", "Edit first");
      edit.type = "button";
      edit.disabled = busy;
      edit.setAttribute("aria-label", `Edit first: ${action.title}`);
      edit.addEventListener("click", () => handlers.apply(action));
      row.append(edit);
    }
    box.append(row);
    return box;
  }

  function actionControl(action: PageAction, state: BlockState): HTMLElement {
    if (action.kind === "comment") return commentControl(action, state.applied[action.id]);
    if (action.kind === "link") {
      const link = node("a", "tb-act");
      link.href = githubHref(action.href) ?? "";
      link.dataset.kind = action.kind;
      link.append(node("span", "tb-act-text", action.title), icon("link"));
      return link;
    }
    const applied = state.applied[action.id];
    const settles = action.kind !== "edit-body";
    const done = applied?.state === "done" && settles;
    const button = node("button", "tb-act");
    button.type = "button";
    button.dataset.kind = action.kind;
    button.dataset.state = applied?.state ?? "ready";
    button.disabled = applied?.state === "applying" || done;
    const text = confirming?.id === action.id ? "Click again to close this pull request" : action.title;
    button.append(node("span", "tb-act-text", applied?.state === "applying" ? `${text}…` : text));
    if (done) button.append(icon("done"));
    button.addEventListener("click", function apply() {
      confirmOrApply(action);
    });
    return button;
  }

  function actions(state: BlockState): HTMLElement[] {
    // A step whose text sits in one of GitHub's fields stays listed, so its Undo is always in reach.
    const inFields = state.actions.filter((action) => Object.values(state.seeded).includes(action.id));
    const others = state.actions.filter((action) => !inFields.includes(action)).slice(0, MOST_ACTIONS - inFields.length);
    const shown = state.actions.filter((action) => inFields.includes(action) || others.includes(action));
    if (!shown.length) return [];
    const list = node("ul", "tb-actions");
    list.setAttribute("aria-label", "Suggested steps");
    for (const action of shown) {
      const item = node("li", "tb-action");
      item.append(actionControl(action, state));
      const spot = SPOTS[action.kind];
      const seeded = spot !== undefined && state.seeded[spot] === action.id;
      const failed = state.applied[action.id]?.state === "failed" ? state.applied[action.id]?.error : undefined;
      if (seeded) {
        const line = node("p", "tb-seeded", spot === "composer" ? "In the comment box. Nothing posts until you press Comment, or Close with comment." : "Added to the description. Nothing saves until you press Update.");
        const undo = node("button", "tb-link", "Undo");
        undo.type = "button";
        undo.addEventListener("click", () => handlers.undo(spot));
        line.append(" ", undo);
        item.append(line);
      } else if (failed) {
        item.append(node("p", "tb-error", failed));
      } else {
        // A step from a failing check repeats that check's line above; a Do or a reviewer suggestion says where it came from.
        if (action.source === "do" || action.kind === "request-review") item.append(node("p", "tb-why", action.why));
      }
      list.append(item);
    }
    const parts: HTMLElement[] = [node("h3", "tb-subhead", "Suggested"), list];
    if (state.actions.length > shown.length) parts.push(node("p", "tb-meta", `${state.actions.length - shown.length} more in the side panel`));
    return parts;
  }

  function foot(state: BlockState): HTMLElement {
    const row = node("div", "tb-foot");
    const rerun = node("button", "tb-link", state.run?.running ? "Running…" : "Run again");
    rerun.type = "button";
    rerun.disabled = state.run?.running === true;
    rerun.addEventListener("click", handlers.rerun);
    row.append(rerun);
    const view = state.view;
    if (view) {
      const copy = node("button", "tb-link", "Copy summary");
      copy.type = "button";
      copy.addEventListener("click", async function copySummary() {
        try {
          await navigator.clipboard.writeText(summaryMarkdown(view));
          status.textContent = "Summary copied as Markdown.";
        } catch (cause) {
          status.textContent = errorText(cause);
        }
      });
      row.append(copy);
    }
    return row;
  }

  function render(state: BlockState) {
    if (last && (last.pr.repo !== state.pr.repo || last.pr.number !== state.pr.number)) status.textContent = "";
    last = state;
    const { view, run } = state;
    const focused = (element.getRootNode() as Document | ShadowRoot).activeElement;
    const refocus = focused instanceof HTMLElement && element.contains(focused) ? [...element.querySelectorAll("button, a")].indexOf(focused) : -1;
    summary.replaceChildren(head(), score(view, run), ...warning(view, run), ...(view ? checks(view) : []));
    steps.replaceChildren(...actions(state));
    steps.hidden = !state.actions.length;
    body.replaceChildren(summary, steps, foot(state));
    if (refocus >= 0) element.querySelectorAll<HTMLElement>("button, a")[refocus]?.focus();
  }

  return { element, render };
}
