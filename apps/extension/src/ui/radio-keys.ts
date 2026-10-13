import type { KeyboardEvent } from "react";

const STEPS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * Arrow keys move the choice in a radio group of buttons, as native radios do; with one tab stop on the checked
 * button (`tabIndex` 0, the rest -1), Tab leaves the group in one step.
 */
export function onRadioKeys(event: KeyboardEvent<HTMLElement>): void {
  const step = STEPS[event.key];
  if (step === undefined) return;
  const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const at = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  event.preventDefault();
  const next = radios[(at + step + radios.length) % radios.length]!;
  next.focus();
  next.click();
}
