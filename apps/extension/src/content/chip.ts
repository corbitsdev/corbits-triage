import type { RunState } from "../storage.ts";
import { scoreOf, type TriageView } from "../view.ts";

type Tone = "pass" | "fail" | "unsure" | "open" | "busy" | "error";

function scoreTone(view: TriageView): Tone {
  if (view.rules.some((rule) => rule.state === "fail")) return "fail";
  if (view.rules.some((rule) => rule.state === "waiting")) return "unsure";
  return "pass";
}

export function summaryOf(view: TriageView | undefined, run: RunState | undefined): { text: string; tone: Tone } {
  if (run?.running) return { text: "Checking", tone: "busy" };
  if (run?.error) return { text: "Could not check", tone: "error" };
  if (!view) return { text: "Not checked yet", tone: "open" };
  if (!view.policy) return { text: "No policy", tone: "open" };
  if (view.paused !== undefined) return { text: "Paused", tone: "open" };
  const { passed, run: ran } = scoreOf(view);
  if (ran === 0) return { text: "Nothing to check here", tone: "open" };
  return { text: `${passed}/${ran} passed`, tone: scoreTone(view) };
}

export type Chip = { element: HTMLElement; render(view: TriageView | undefined, run: RunState | undefined): void };

/** The score beside the pull request's title; a click brings Triage's block in the sidebar into view. */
export function verdictChip(onClick: () => void): Chip {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "chip";
  element.addEventListener("click", onClick);

  function render(view: TriageView | undefined, run: RunState | undefined) {
    const { text, tone } = summaryOf(view, run);
    element.dataset.tone = tone;
    element.textContent = `Triage: ${text}`;
    element.setAttribute("aria-label", `Corbits Triage: ${text}. Show the checks.`);
  }

  return { element, render };
}
