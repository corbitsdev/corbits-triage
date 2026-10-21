import type { VerdictWord } from "@corbits/triage-contracts";
import type { RunState } from "../storage.ts";
import type { TriageView } from "../view.ts";

type Tone = VerdictWord | "open" | "busy" | "error";

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

export function summaryOf(view: TriageView | undefined, run: RunState | undefined): { text: string; tone: Tone } {
  if (run?.running) return { text: "Checking", tone: "busy" };
  if (run?.error) return { text: "Could not check", tone: "error" };
  if (!view) return { text: "Not checked yet", tone: "open" };
  if (!view.policy) return { text: "No policy", tone: "open" };
  if (view.decided) return { text: VERDICT_NAMES[view.decided.verdict], tone: view.decided.verdict };
  return { text: "Needs the decision model", tone: "open" };
}

export type Chip = { element: HTMLElement; render(view: TriageView | undefined, run: RunState | undefined): void };

/** The verdict beside the pull request's title; a click brings Triage's block in the sidebar into view. */
export function verdictChip(onClick: () => void): Chip {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "chip";
  element.addEventListener("click", onClick);

  function render(view: TriageView | undefined, run: RunState | undefined) {
    const { text, tone } = summaryOf(view, run);
    element.dataset.tone = tone;
    element.textContent = `Triage: ${text}`;
    element.setAttribute("aria-label", `Corbits Triage: ${text}. Show the rules.`);
  }

  return { element, render };
}
