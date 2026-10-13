import { clock } from "../clock.ts";
import { send } from "../messages.ts";
import type { PrRef } from "../pr.ts";
import type { RunState } from "../storage.ts";
import { checkReason, shownChecks, summaryMarkdown } from "../summary.ts";
import { nextStep, stateName, toneOf, type Tone, type TriageView } from "../view.ts";
import { errorText } from "../error-text.ts";

// The hover card names this many failing checks, then how many more.
const TOP_FAILING = 3;
// Long enough to cross from the chip to the card without it closing.
const HIDE_DELAY_MS = 200;
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

type Label = { score: string; text: string; tone: Tone; busy: boolean; stale: boolean };

function chipLabel(view: TriageView | undefined, state: RunState | undefined): Label {
  if (state?.running) return { score: view?.readiness?.toString() ?? "…", text: "Running triage", tone: view ? toneOf(view) : "unknown", busy: true, stale: false };
  if (state?.error && view) {
    const moved = state.head !== undefined && state.head !== view.headSha;
    return { score: view.readiness?.toString() ?? "–", text: moved ? "Stale · new commits" : `Last run ${clock(view.ranAt)}`, tone: toneOf(view), busy: false, stale: true };
  }
  if (state?.error) return { score: "!", text: state.resetAt ? `GitHub limit until ${clock(state.resetAt)}` : "Could not run", tone: "unknown", busy: false, stale: false };
  if (!view) return { score: "…", text: "Not triaged yet", tone: "unknown", busy: false, stale: false };
  return { score: view.readiness?.toString() ?? "–", text: stateName(view), tone: toneOf(view), busy: false, stale: false };
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(text: string, onClick: () => void): HTMLButtonElement {
  const button = element("button", "card-action", text);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

export type Chip = { element: HTMLElement; render(pr: PrRef, view: TriageView | undefined, state: RunState | undefined): void };

/**
 * The score chip beside the pull request's title. A click opens the side panel; hovering or focusing it shows a card
 * with the next step, the top failing checks and quick actions. The card is a popover, so GitHub's overflow never clips it.
 */
export function scoreChip(): Chip {
  const wrap = element("span", "chip-wrap");
  const button = element("button", "chip");
  button.type = "button";
  button.innerHTML = `<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring-track" cx="8" cy="8" r="${RING_RADIUS}"/><circle class="ring-fill" cx="8" cy="8" r="${RING_RADIUS}" transform="rotate(-90 8 8)"/></svg><span class="score"></span><span class="state"></span>`;
  const card = element("div", "card");
  card.id = "corbits-triage-card";
  card.setAttribute("popover", "manual");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Corbits Triage summary");
  wrap.append(button, card);

  let current: { pr: PrRef; view: TriageView | undefined } | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  // Escape closes the card until the pointer or focus leaves, so returning focus to the chip does not reopen it.
  let dismissed = false;

  function place() {
    const rect = button.getBoundingClientRect();
    const width = Math.min(340, window.innerWidth - 16);
    card.style.width = `${width}px`;
    card.style.top = `${rect.bottom + 6}px`;
    card.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  }

  function show() {
    clearTimeout(hideTimer);
    if (dismissed || !current || !card.isConnected || card.matches(":popover-open")) return;
    place();
    card.showPopover();
    window.addEventListener("scroll", hideNow, { passive: true, once: true });
  }

  function hideNow() {
    clearTimeout(hideTimer);
    if (card.matches(":popover-open")) card.hidePopover();
  }

  function hideSoon() {
    dismissed = false;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideNow, HIDE_DELAY_MS);
  }

  function openPanel() {
    send({ type: "open-panel" });
  }

  button.addEventListener("click", openPanel);
  for (const target of [button, card]) {
    target.addEventListener("mouseenter", show);
    target.addEventListener("mouseleave", hideSoon);
  }
  button.addEventListener("focus", show);
  wrap.addEventListener("focusout", function onFocusOut(event) {
    if (!wrap.contains(event.relatedTarget as Node | null)) hideSoon();
  });
  wrap.addEventListener("keydown", function onKey(event) {
    if (event.key !== "Escape" || !card.matches(":popover-open")) return;
    dismissed = true;
    hideNow();
    button.focus();
  });

  function cardBody(pr: PrRef, view: TriageView | undefined, state: RunState | undefined, label: Label): Node[] {
    const head = element("div", "card-head");
    head.append(element("span", "card-score", label.score), element("span", "card-state", view && !label.busy ? stateName(view) : label.text));
    const nodes: Node[] = [head];
    if (state?.error) nodes.push(element("p", "card-warn", view ? `Could not refresh: ${state.error} Showing the run from ${clock(view.ranAt)}.` : state.error));
    if (view) {
      const next = element("p", "card-next", nextStep(view));
      next.id = "corbits-triage-card-next";
      nodes.push(next);
      const failing = shownChecks(view).filter((check) => check.result === "fail");
      if (failing.length) {
        const list = element("ul", "card-checks");
        for (const check of failing.slice(0, TOP_FAILING)) {
          const item = element("li", "");
          item.append(element("b", "", `${check.name}:`), document.createTextNode(` ${checkReason(check)}`));
          list.append(item);
        }
        if (failing.length > TOP_FAILING) list.append(element("li", "card-more", `and ${failing.length - TOP_FAILING} more failing`));
        nodes.push(list);
      }
    }
    const status = element("p", "card-status");
    status.setAttribute("role", "status");
    const actions = element("div", "card-actions");
    const open = actionButton("Open panel", openPanel);
    open.dataset.primary = "true";
    const rerun = actionButton(label.busy ? "Running…" : "Run again", function runAgain() {
      send({ type: "triage", pr, mode: "refetch" });
    });
    rerun.disabled = label.busy;
    actions.append(open, rerun);
    if (view) {
      actions.append(actionButton("Copy summary", async function copy() {
        try {
          await navigator.clipboard.writeText(summaryMarkdown(view));
          status.textContent = "Summary copied as Markdown.";
        } catch (cause) {
          status.textContent = errorText(cause);
        }
      }));
    }
    nodes.push(actions, status);
    return nodes;
  }

  function render(pr: PrRef, view: TriageView | undefined, state: RunState | undefined) {
    current = { pr, view };
    const label = chipLabel(view, state);
    button.dataset.tone = label.tone;
    button.dataset.busy = String(label.busy);
    button.dataset.stale = String(label.stale);
    button.setAttribute("aria-label", `Corbits Triage for #${pr.number}: ${label.score === "…" || label.score === "!" ? "" : `score ${label.score}, `}${label.text}. Open the side panel.`);
    button.querySelector(".score")!.textContent = label.score;
    button.querySelector(".state")!.textContent = label.text;
    const filled = view?.readiness == null ? 0 : (RING_LENGTH * view.readiness) / 100;
    button.querySelector<SVGCircleElement>(".ring-fill")!.style.strokeDasharray = `${filled} ${RING_LENGTH}`;
    // A run finishing re-renders the card under the person's focus, so focus returns to the same action.
    const focused = (wrap.getRootNode() as Document | ShadowRoot).activeElement;
    const refocus = focused instanceof HTMLButtonElement && card.contains(focused) ? focused.textContent : null;
    card.replaceChildren(...cardBody(pr, view, state, label));
    if (view) button.setAttribute("aria-describedby", "corbits-triage-card-next");
    else button.removeAttribute("aria-describedby");
    // A run started from the card swaps "Run again" for "Running…", so a missing match keeps focus on Open panel.
    if (refocus !== null) ([...card.querySelectorAll("button")].find((each) => each.textContent === refocus) ?? card.querySelector("button"))?.focus();
    if (card.matches(":popover-open")) place();
  }

  return { element: wrap, render };
}
