export function asText(v: unknown) {
  return typeof v === "string" ? v : JSON.stringify(v ?? "");
}

export function parseJsonText(text: string, open: "{" | "[" = "{"): unknown {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** The most goals one issue is judged on. */
const MAX_GOALS = 10;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const GOALS_HEADING = /^(?:acceptance criteria|outcomes?)$/i;

/**
 * An issue's goals: the list items under an Acceptance criteria or Outcome heading, or, with no such heading, its
 * checkbox items, so a template's checklist never stands in for the goals. Code blocks hold no goals.
 */
export function ticketGoals(markdown: string): string[] {
  const listed: string[] = [];
  const boxes: string[] = [];
  let headed = false;
  let under = false;
  let fenced = false;
  for (const line of markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line)) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      under = GOALS_HEADING.test(heading[1]!);
      headed ||= under;
      continue;
    }
    const item = under ? LIST_ITEM.exec(line)?.[1] : undefined;
    if (item !== undefined) listed.push(item);
    const box = CHECKBOX.exec(line)?.[1];
    if (box !== undefined) boxes.push(box);
  }
  return (headed ? listed : boxes).slice(0, MAX_GOALS);
}

const PASSING = /\b(?:pass|passes|passing|green)\b/i;
const CHECKED_BY = /\b(?:checks?|tests?|ci|build|lint|typecheck)\b|\.test\./i;
const OUTSIDE_THE_CODE = /\b(?:verified live|live on|throwaway|running app|visual change|announced|manual(?:ly)?|spot-check|is ended|are ended)\b/i;

/**
 * How a goal is checked: one that checks or tests pass is the CI rule's, one only a live, manual or outside step can
 * show is a person's, and the rest are code review's.
 */
export function goalKind(goal: string): "ci" | "outside" | "code" {
  if (PASSING.test(goal) && CHECKED_BY.test(goal)) return "ci";
  if (OUTSIDE_THE_CODE.test(goal)) return "outside";
  return "code";
}
