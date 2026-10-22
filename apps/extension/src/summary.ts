import { nextStep, readinessOf, stateName, type TriageView, type ViewCheck } from "./view.ts";

const ORDER: Record<ViewCheck["result"], number> = { fail: 0, unconfirmed: 1, "needs-judge": 2, pass: 3 };

export const RESULT_NAMES: Record<ViewCheck["result"], string> = { pass: "Passed", fail: "Failed", unconfirmed: "Not confirmed", "needs-judge": "Not run here" };

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The workflow's reason as a sentence; custom checks prefix theirs with their name, which a row already shows. */
export function checkReason(check: ViewCheck): string {
  return capitalized(check.reason.startsWith(`${check.name}: `) ? check.reason.slice(check.name.length + 2) : check.reason);
}

/** Failures first, then what is not settled, then what is not run here, then passes. */
export function shownChecks(view: TriageView): ViewCheck[] {
  return [...view.checks].sort((a, b) => ORDER[a.result] - ORDER[b.result]);
}

/** The run as Markdown, for pasting into a review, a chat or an issue. */
export function summaryMarkdown(view: TriageView): string {
  const lines = [
    `**${view.pr.repo}#${view.pr.number}**: ${readinessOf(view) ?? "–"}/100, ${stateName(view)}`,
    `Next: ${nextStep(view)}`,
    "",
    ...shownChecks(view).map((check) => `- ${RESULT_NAMES[check.result]}: **${check.name}**, ${checkReason(check)}`),
  ];
  return lines.join("\n");
}
