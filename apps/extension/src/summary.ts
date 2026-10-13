import { nextStep, stateName, type TriageView, type ViewCheck } from "./view.ts";

// The workflow's own check for requested changes has no catalog name.
const NAMES: Record<string, string> = { review: "Requested changes" };

const ORDER: Record<ViewCheck["result"], number> = { fail: 0, unconfirmed: 1, "needs-judge": 2, pass: 3 };

export function checkLabel(check: ViewCheck): string {
  return NAMES[check.check] ?? check.name;
}

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

/** Failures first, then what is not settled, then passes; gates decide actions and are not findings. */
export function shownChecks(view: TriageView): ViewCheck[] {
  return view.checks.filter((check) => !check.gate && !unasked(check)).sort((a, b) => ORDER[a.result] - ORDER[b.result]);
}

export const RESULT_NAMES: Record<ViewCheck["result"], string> = { pass: "Passed", fail: "Failed", unconfirmed: "Not confirmed", "needs-judge": "Not answered" };

/** The triage as Markdown, for pasting into a review, a chat or an issue. */
export function summaryMarkdown(view: TriageView): string {
  const lines = [
    `**${view.pr.repo}#${view.pr.number}**: ${view.readiness ?? "–"}/100, ${stateName(view)}`,
    `Next: ${nextStep(view)}`,
    "",
    ...shownChecks(view).map((check) => `- ${RESULT_NAMES[check.result]}: **${checkLabel(check)}**, ${checkReason(check)}`),
  ];
  return lines.join("\n");
}
