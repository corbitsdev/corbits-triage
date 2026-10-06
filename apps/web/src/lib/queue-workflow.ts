// SPDX-License-Identifier: GPL-2.0-only

const INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "option",
  "summary",
  "details",
  "label",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=menuitem]",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]:not([tabindex='-1'])",
  "audio[controls]",
  "video[controls]",
].join(", ");

export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => unknown } | null;
  return typeof candidate?.closest === "function" && candidate.closest(INTERACTIVE_SELECTOR) !== null;
}
