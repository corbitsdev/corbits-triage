import { type } from "arktype";

const LineRangeSchema = type({ start: "number.integer >= 1", end: "number.integer >= 1" });

/** `removed` is in the base file at its own path, which a rename changes. */
export const LineCitationSchema = type({ path: "string", "added?": LineRangeSchema, "removed?": LineRangeSchema.and({ path: "string" }) });

export type LineCitation = typeof LineCitationSchema.infer;

const ItemsSchema = type("string").or(LineCitationSchema).array();

export type CheckItem = typeof ItemsSchema.infer[number];

/**
 * What a check found, beside its pass, fail or unconfirmed result. Values are facts named for what they state
 * (`hasConflicts: true`, `status: "pending"`, `files: 33`). A score is 0 to 100, how likely the check is fine, unrounded,
 * with the bar at which the check passes, the files or hunks behind it and any it could not read. A level is what a score
 * rule was rated, of its levels worst first. Met, not applicable and could not check are states, never numbers; a check
 * skipped for a reason, such as focused on a stacked branch, is not applicable with that reason.
 */
const CheckOutputSchema = type({ kind: "'values'", values: "Record<string, number | boolean | string>" })
  .or({ kind: "'score'", score: "0 <= number <= 100", passAt: "0 <= number <= 100", items: ItemsSchema, "unread?": "string[]" })
  .or({ kind: "'level'", level: "string", levels: "string[]", "failBelow?": "string" })
  .or({ kind: "'met'", items: ItemsSchema })
  .or({ kind: "'not-applicable'", "reason?": "string" })
  .or({ kind: "'could-not-check'", reason: "string", "items?": ItemsSchema });

export type CheckOutput = typeof CheckOutputSchema.infer;

/** Undefined for a check recorded before checks carried output. */
export function parseCheckOutput(raw: unknown): CheckOutput | undefined {
  const output = CheckOutputSchema(raw);
  return output instanceof type.errors ? undefined : output;
}

function lineRange({ start, end }: { start: number; end: number }, dash: string): string {
  return start === end ? `${start}` : `${start}${dash}${end}`;
}

function removedText(citation: LineCitation): string {
  const { removed } = citation;
  if (!removed) return "";
  const lines = `${removed.start === removed.end ? "line" : "lines"} ${lineRange(removed, "–")}`;
  return ` (removed ${lines}${removed.path === citation.path ? "" : ` of ${removed.path}`})`;
}

/** An item as evidence reads it: `src/router.ts:40-58`, `src/router.ts (removed lines 12–15)`, or both: `src/router.ts:2 (removed lines 1–8)`. */
export function itemText(item: CheckItem): string {
  if (typeof item === "string") return item;
  return `${item.path}${item.added ? `:${lineRange(item.added, "-")}` : ""}${removedText(item)}`;
}

export function citationOf(output: CheckOutput | null | undefined, evidence: string): LineCitation | undefined {
  if (!output || output.kind === "values" || output.kind === "level" || output.kind === "not-applicable") return undefined;
  return output.items?.find((item): item is LineCitation => typeof item !== "string" && itemText(item) === evidence);
}

/** Parentheses are escaped too, so the URL cannot end a markdown link early. */
function urlSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()]/g, (paren) => `%${paren.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The added lines in the file at the judged head commit; removed lines are not there, so a citation of only those has no
 * link. `plain=1` shows rendered files such as Markdown as source, so the lines highlight.
 */
export function citationUrl(repo: string, headSha: string, citation: LineCitation): string | undefined {
  const { added } = citation;
  if (!added) return undefined;
  const path = citation.path.split("/").map(urlSegment).join("/");
  const lines = added.start === added.end ? `L${added.start}` : `L${added.start}-L${added.end}`;
  return `https://github.com/${repo}/blob/${headSha}/${path}?plain=1#${lines}`;
}
