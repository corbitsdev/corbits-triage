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
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
// A markdown heading, or a line that is only bold text or ends in a colon.
const HEADING = /^\s*(?:#{1,6}\s+(.*?)\s*#*|(?:\*\*|__)(.+?):?(?:\*\*|__):?|([^-*+\d\s].*?):)\s*$/;
const FENCE = /^\s*(?:```|~~~)/;
const GOALS_HEADING = /^(?:acceptance criteria|outcomes?)\b/i;

/**
 * An issue's goals: the list items under an Acceptance criteria or Outcome heading, none without one, so a template's
 * checklist never stands in for them. Code blocks hold no goals.
 */
export function ticketGoals(markdown: string): string[] {
  const goals: string[] = [];
  let under = false;
  let fenced = false;
  for (const line of markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/)) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line)) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      under = GOALS_HEADING.test((heading[1] ?? heading[2] ?? heading[3])!);
      continue;
    }
    const item = under ? LIST_ITEM.exec(line)?.[1] : undefined;
    if (item !== undefined) goals.push(item);
  }
  return goals.slice(0, MAX_GOALS);
}
