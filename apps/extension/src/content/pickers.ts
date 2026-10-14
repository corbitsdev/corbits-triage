import { checkboxFor } from "./act.ts";

const PICKERS = { labels: "Select labels", reviewers: "Select reviewers" } as const;

export type PickerSuggestions = Record<keyof typeof PICKERS, string[]>;

const MARK = "corbits-triage-suggested";

function rowOf(box: HTMLInputElement): HTMLElement {
  return box.closest<HTMLElement>("[role^='menuitem'], label") ?? box;
}

/** GitHub's row stays a toggle, so clicking it again takes the suggestion back. */
function mark(row: HTMLElement): void {
  if (row.querySelector(`.${MARK}`)) return;
  const note = document.createElement("span");
  note.className = MARK;
  note.textContent = "Suggested by Triage";
  note.title = "Checked by Corbits Triage. Click the row to uncheck it.";
  note.style.cssText = "margin-inline-start:auto;padding-inline-start:8px;font-size:12px;color:var(--fgColor-muted,#59636e);white-space:nowrap";
  row.append(note);
}

/**
 * When the person opens GitHub's label or reviewer picker, each value Triage suggests is checked, as a click on its row
 * would, and marked; nothing is sent until the person closes the picker, as with their own clicks. Each value is
 * offered once per pull request: `offered` and `offer` keep that across reloads, so a value the person unchecked is
 * never checked again.
 */
export function pickerSeeder(offered: (value: string) => boolean, offer: (value: string) => void) {
  function fill(details: HTMLDetailsElement, values: string[]) {
    const menu = details.querySelector("details-menu, [role='menu']");
    if (!menu || !menu.querySelector('input[type="checkbox"]')) return;
    for (const value of values.filter((each) => !offered(each))) {
      const box = checkboxFor(menu, value);
      if (!box) continue;
      offer(value);
      if (box.checked) continue;
      const row = rowOf(box);
      row.click();
      if (box.checked) mark(row);
    }
  }

  function update(suggestions: PickerSuggestions) {
    for (const [kind, label] of Object.entries(PICKERS) as Array<[keyof typeof PICKERS, string]>) {
      const values = suggestions[kind];
      if (!values.length) continue;
      const details = document.querySelector(`form[aria-label="${label}"]`)?.querySelector<HTMLDetailsElement>("details[open]");
      if (details) fill(details, values);
    }
  }

  return { update };
}
