import { errorText } from "@corbits/common";
import type { PostedCodeReview } from "@corbits/github-reads";
import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import { findingTitle, POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { clock } from "../clock.ts";
import type { RunState } from "../storage.ts";
import { checkReason, shownChecks, summaryMarkdown } from "../summary.ts";
import { nextStep, readinessOf, stateName, toneOf, type TriageView } from "../view.ts";

const POLICY_GUIDE_URL = "https://github.com/corbitsdev/corbits-triage/blob/main/docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#writing-the-file";
const RING_RADIUS = 13;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

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
 * Triage's section atop GitHub's pull request sidebar, on every pull request: the score and state, the next step, the
 * checks to look at in a line each and the policy file.
 */
export function triageBlock(handlers: BlockHandlers): TriageBlock {
  const element = node("section", "tb");
  element.setAttribute("aria-label", "Corbits Triage");
  let shownPr: string | undefined;
  // One live region for the block's whole life, so screen readers announce what is written into it.
  const status = node("p", "tb-status");
  status.setAttribute("role", "status");
  const body = node("div", "tb-body");
  element.append(body, status);

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
    const readiness = view ? readinessOf(view) : null;
    const filled = readiness === null ? 0 : (RING_LENGTH * readiness) / 100;
    ring.innerHTML = `<circle class="tb-ring-track" cx="16" cy="16" r="${RING_RADIUS}"/><circle class="tb-ring-fill" cx="16" cy="16" r="${RING_RADIUS}" transform="rotate(-90 16 16)" stroke-dasharray="${filled} ${RING_LENGTH}"/>`;
    const number = node("span", "tb-number", readiness?.toString() ?? (run?.running ? "…" : "–"));
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
    return [node("p", "tb-warn", view ? `${run.error} Showing the run from ${clock(view.ranAt)}.` : run.error)];
  }

  function checks(view: TriageView): HTMLElement[] {
    const shown = shownChecks(view);
    const open = shown.filter((check) => check.result !== "pass");
    const list = node("ul", "tb-checks");
    list.setAttribute("aria-label", "Checks to look at");
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
    const passed = shown.filter((check) => check.result === "pass").length;
    const parts: HTMLElement[] = open.length ? [list] : [];
    if (passed) parts.push(node("p", "tb-meta", open.length ? `${passed} passed` : `All ${passed} checks passed`));
    return parts;
  }

  function policyLine(view: TriageView): HTMLElement {
    if (!view.policy) {
      const guide = node("p", "tb-meta", `This repository has no ${POLICY_FILE_PATH} on its default branch, so there is nothing to check. `);
      guide.append(link("How to write one", POLICY_GUIDE_URL), ".");
      return guide;
    }
    const line = node("p", "tb-meta", "Policy: ");
    line.append(link(view.policy.path, view.policy.url), " on the default branch");
    return line;
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

  function foot(view: TriageView | undefined, run: RunState | undefined): HTMLElement {
    const row = node("div", "tb-foot");
    const rerun = node("button", "tb-link", run?.running ? "Running…" : "Run again");
    rerun.type = "button";
    rerun.disabled = run?.running === true;
    rerun.addEventListener("click", handlers.rerun);
    row.append(rerun);
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

  function render(view: TriageView | undefined, run: RunState | undefined) {
    const key = view && `${view.pr.repo}#${view.pr.number}`;
    if (key !== shownPr) status.textContent = "";
    shownPr = key;
    const focused = (element.getRootNode() as Document | ShadowRoot).activeElement;
    const refocus = focused instanceof HTMLElement && element.contains(focused) ? [...element.querySelectorAll("button, a")].indexOf(focused) : -1;
    const checked = view?.policy && view.paused === undefined;
    const details = view ? [policyLine(view), ...(checked ? checks(view) : []), ...codeReviewPart(view.codeReview)] : [];
    body.replaceChildren(head(), score(view, run), ...warning(view, run), ...details, foot(view, run));
    if (refocus >= 0) element.querySelectorAll<HTMLElement>("button, a")[refocus]?.focus();
  }

  return { element, render };
}
