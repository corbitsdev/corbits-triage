import { nextStep, stateName, type TriageView, type ViewCheck } from "./view.ts";

const ORDER: Record<ViewCheck["result"], number> = { fail: 0, unconfirmed: 1, "needs-judge": 2, pass: 3 };

function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** The workflow's reason as a sentence; custom checks prefix theirs with their name, which a row already shows. */
export function checkReason(check: ViewCheck): string {
  return capitalized(check.reason.startsWith(`${check.name}: `) ? check.reason.slice(check.name.length + 2) : check.reason);
}

/** A model check no decision model answered: without one it is not shown anywhere. */
function unasked(check: ViewCheck): boolean {
  return check.result === "needs-judge" || (check.kind === "model" && check.reason === "not asked");
}

/** Failures first, then what is not settled, then passes. */
export function shownChecks(view: TriageView): ViewCheck[] {
  return view.checks.filter((check) => !unasked(check)).sort((a, b) => ORDER[a.result] - ORDER[b.result]);
}

export const RESULT_NAMES: Record<ViewCheck["result"], string> = { pass: "Passed", fail: "Failed", unconfirmed: "Not confirmed", "needs-judge": "Not answered" };

/** The triage as Markdown, for pasting into a review, a chat or an issue. */
export function summaryMarkdown(view: TriageView): string {
  const lines = [
    `**${view.pr.repo}#${view.pr.number}**: ${view.readiness ?? "–"}/100, ${stateName(view)}`,
    `Next: ${nextStep(view)}`,
    "",
    ...shownChecks(view).map((check) => `- ${RESULT_NAMES[check.result]}: **${check.name}**, ${checkReason(check)}`),
  ];
  return lines.join("\n");
}
