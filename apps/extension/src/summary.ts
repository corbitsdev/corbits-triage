import type { TriageView, ViewCheck } from "./view.ts";

const ORDER: Record<ViewCheck["result"], number> = { fail: 0, unconfirmed: 1, pass: 2 };

export const RESULT_NAMES: Record<ViewCheck["result"], string> = { pass: "Passed", fail: "Failed", unconfirmed: "Not confirmed" };

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The workflow's reason as a sentence; custom checks prefix theirs with their name, which a row already shows. */
export function checkReason(check: ViewCheck): string {
  return capitalized(check.reason.startsWith(`${check.name}: `) ? check.reason.slice(check.name.length + 2) : check.reason);
}

/** Failures first, then what is not settled, then passes. */
export function shownChecks(view: TriageView): ViewCheck[] {
  return [...view.checks].sort((a, b) => ORDER[a.result] - ORDER[b.result]);
}
