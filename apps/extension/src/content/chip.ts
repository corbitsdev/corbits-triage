import { send } from "../messages.ts";
import type { PrRef } from "../pr.ts";
import type { RunState } from "../storage.ts";
import { statusOf, type TriageView } from "../view.ts";

export type Chip = { element: HTMLElement; render(pr: PrRef, view: TriageView | undefined, state: RunState | undefined): void };

/** The status beside the pull request's title: a ring that spins while Triage runs, then turns green on Pass or red on Fail. A click opens the side panel. */
export function scoreChip(): Chip {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chip";
  button.innerHTML = '<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="ring-track" cx="8" cy="8" r="6"/><circle class="ring-fill" cx="8" cy="8" r="6" transform="rotate(-90 8 8)"/></svg><span class="state"></span>';
  button.addEventListener("click", function openPanel() {
    send({ type: "open-panel" });
  });

  function render(pr: PrRef, view: TriageView | undefined, state: RunState | undefined) {
    const { text, tone } = statusOf(view, state);
    button.dataset.tone = tone;
    button.querySelector(".state")!.textContent = text;
    button.setAttribute("aria-label", `Corbits Triage for #${pr.number}: ${text}. Open the side panel.`);
  }

  return { element: button, render };
}
