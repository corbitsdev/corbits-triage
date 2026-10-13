import type { Seed } from "./seeds.ts";

export type SeedNote = { element: HTMLElement; render(seed: Seed | undefined): void };

const WHERE: Record<Seed["spot"], string> = {
  composer: "Nothing posts until you press Comment, or Close with comment.",
  body: "Nothing saves until you press Update.",
};

/** The line beside one of GitHub's fields that says Triage put text in it, with Undo to take that text back out. */
export function seedNote(onUndo: () => void): SeedNote {
  const element = document.createElement("p");
  element.className = "seed-note";
  element.setAttribute("role", "status");
  const text = document.createElement("span");
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "seed-undo";
  undo.textContent = "Undo";
  undo.addEventListener("click", onUndo);
  element.append(text, undo);
  let shown: string | undefined;

  function render(seed: Seed | undefined) {
    const line = seed ? `Triage drafted “${seed.title}” here. ${WHERE[seed.spot]}` : undefined;
    if (line === shown) return;
    shown = line;
    element.hidden = !seed;
    text.textContent = line ?? "";
    undo.setAttribute("aria-label", seed ? `Undo: take Triage's “${seed.title}” back out` : "Undo");
  }

  return { element, render };
}
