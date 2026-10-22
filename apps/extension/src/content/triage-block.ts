import type { PostedCodeReview } from "@corbits/github-reads";
import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import { findingTitle, POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { clock } from "../clock.ts";
import type { RunState } from "../storage.ts";
import { checkReason, shownChecks } from "../summary.ts";
import { nextStep, outcomeOf, type TriageView, type ViewCheck } from "../view.ts";

const POLICY_GUIDE_URL = "https://github.com/corbitsdev/corbits-triage/blob/main/docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#writing-the-file";

const ICONS = {
  fail: '<path d="M5 5l6 6M11 5l-6 6"/>',
  unsure: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v3M8 10.5v.5"/>',
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

function link(text: string, href: string): HTMLAnchorElement {
  const made = node("a", "", text);
  made.href = href;
  return made;
}

export type BlockHandlers = { openPanel(): void; rerun(): void };

export type TriageBlock = { element: HTMLElement; render(view: TriageView | undefined, run: RunState | undefined): void };

/**
 * Triage's section atop GitHub's pull request sidebar: the reasons behind the status beside the title, each failed check
 * with its reason or how many passed, and Triage again. The status itself shows only beside the title.
 */
export function triageBlock(handlers: BlockHandlers): TriageBlock {
  const element = node("section", "tb");
  element.setAttribute("aria-label", "Corbits Triage");
  const body = node("div", "tb-body");
  element.append(body);

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

  function warning(view: TriageView | undefined, run: RunState | undefined): HTMLElement[] {
    if (!run?.error) return [];
    return [node("p", "tb-warn", view ? `${run.error} Showing the run from ${clock(view.ranAt)}.` : run.error)];
  }

  function markLabel(check: ViewCheck): string {
    if (check.result === "fail") return "Failed";
    return check.check === "ci-green" ? "Running" : "Not settled";
  }

  /** The checks that failed or are not settled yet, each with its reason; on a Pass, how many passed. */
  function checks(view: TriageView): HTMLElement[] {
    const open = shownChecks(view).filter((check) => check.result !== "pass");
    if (!open.length) return [node("p", "tb-meta", nextStep(view))];
    const list = node("ul", "tb-checks");
    list.setAttribute("aria-label", "Checks to look at");
    for (const check of open) {
      const item = node("li", "tb-check");
      item.dataset.result = check.result;
      const mark = node("span", "tb-mark");
      mark.setAttribute("role", "img");
      mark.setAttribute("aria-label", markLabel(check));
      mark.append(icon(check.result === "fail" ? "fail" : "unsure"));
      const reason = checkReason(check);
      const text = node("span", "tb-check-text");
      text.title = `${check.name}: ${reason}`;
      text.append(node("b", "", check.name), document.createTextNode(` ${reason}`));
      item.append(mark, text);
      list.append(item);
    }
    return [list];
  }

  function reasons(view: TriageView): HTMLElement[] {
    if (!view.policy) {
      const guide = node("p", "tb-meta", `This repository has no ${POLICY_FILE_PATH} on its default branch, so there is nothing to check. `);
      guide.append(link("How to write one", POLICY_GUIDE_URL), ".");
      return [guide];
    }
    if (view.paused !== undefined || outcomeOf(view.checks) === "none") return [node("p", "tb-meta", nextStep(view))];
    return checks(view);
  }

  function findingLink(comment: PostedCodeReview["comments"][number]): HTMLElement {
    const item = node("li", "tb-finding");
    item.append(link(findingTitle(comment), comment.url), node("span", "tb-meta", comment.line === null ? `${comment.path} · outdated` : `${comment.path}:${comment.line}`));
    return item;
  }

  function codeReviewPart(read: TriageView["codeReview"]): HTMLElement[] {
    if ("error" in read) return [node("h3", "tb-subhead", "Code review"), node("p", "tb-warn", `Couldn't read the code review: ${read.error}`)];
    const { review } = read;
    if (!review) return [];
    const head = node("h3", "tb-subhead");
    head.append(link("Code review", review.url), ` by ${review.author}`);
    const parts: HTMLElement[] = [head];
    if (review.earlier) parts.push(node("p", "tb-meta", "For an earlier commit."));
    if (review.comments.length) {
      const list = node("ul", "tb-findings");
      list.setAttribute("aria-label", "Code review comments");
      list.append(...review.comments.map(findingLink));
      parts.push(list);
    }
    return parts;
  }

  function foot(run: RunState | undefined): HTMLElement {
    const row = node("div", "tb-foot");
    const again = node("button", "tb-link", run?.running ? "Triaging…" : "Triage again");
    again.type = "button";
    again.disabled = run?.running === true;
    again.addEventListener("click", handlers.rerun);
    row.append(again);
    return row;
  }

  function render(view: TriageView | undefined, run: RunState | undefined) {
    const focused = (element.getRootNode() as Document | ShadowRoot).activeElement;
    const refocus = focused instanceof HTMLElement && element.contains(focused) ? [...element.querySelectorAll("button, a")].indexOf(focused) : -1;
    const details = view && !run?.running ? [...reasons(view), ...codeReviewPart(view.codeReview)] : [];
    body.replaceChildren(head(), ...warning(view, run), ...details, foot(run));
    if (refocus >= 0) element.querySelectorAll<HTMLElement>("button, a")[refocus]?.focus();
  }

  return { element, render };
}
