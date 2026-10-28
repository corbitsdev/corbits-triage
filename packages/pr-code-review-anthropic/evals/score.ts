import { samePath, type Finding } from "@corbits/pr-code-review/findings";
import type { CaseKey, Reach, Site } from "./cases.js";

export { parseFindings, type Finding } from "@corbits/pr-code-review/findings";

/** Lines a finding may sit from a site and still hit it. */
const SLACK = 3;

function hits(finding: Finding, site: Site): boolean {
  return samePath(finding.path, site.path) && finding.start <= site.end + SLACK && finding.end >= site.start - SLACK;
}

export const REACHES: readonly Reach[] = ["diff", "repo", "intent"];

/** What a finding scored: the bug it caught, the ignored item it used up, or a false alarm. */
export type Outcome = { kind: "caught"; bug: string } | { kind: "ignored"; item: string } | { kind: "falseAlarm" };

export interface CaseScore {
  caught: string[];
  falseAlarms: number;
  /** Findings that used up an ignored item: a true finding that is not a bug. */
  ignored: number;
  flaggedClean: boolean;
  /** Each finding's outcome, in the findings' order. */
  outcomes: Outcome[];
}

/**
 * Each finding, in order, catches the first bug it hits that no earlier finding caught. A finding that hits only caught
 * bugs is a false alarm, so one defect split into several findings scores one bug and the rest as false alarms. A finding
 * that hits no bug uses up the first ignored item it hits that no earlier finding used, else it is a false alarm. A
 * clean case is flagged by any false alarm.
 */
export function scoreCase(key: CaseKey, findings: readonly Finding[]): CaseScore {
  const caught = new Set<string>();
  const used = new Set<string>();
  function outcomeOf(finding: Finding): Outcome {
    const hit = key.bugs.filter((bug) => bug.sites.some((site) => hits(finding, site)));
    const bug = hit.find((candidate) => !caught.has(candidate.id));
    if (bug) {
      caught.add(bug.id);
      return { kind: "caught", bug: bug.id };
    }
    if (hit.length > 0) return { kind: "falseAlarm" };
    const item = key.ignored.find((candidate) => !used.has(candidate.id) && candidate.sites.some((site) => hits(finding, site)));
    if (!item) return { kind: "falseAlarm" };
    used.add(item.id);
    return { kind: "ignored", item: item.id };
  }
  const outcomes = findings.map(outcomeOf);
  const falseAlarms = outcomes.filter((outcome) => outcome.kind === "falseAlarm").length;
  return {
    caught: key.bugs.filter((bug) => caught.has(bug.id)).map((bug) => bug.id),
    falseAlarms,
    ignored: used.size,
    flaggedClean: key.kind === "clean" && falseAlarms > 0,
    outcomes,
  };
}

interface HeadLine {
  path: string;
  line: number;
  text: string;
}

/** Every head-side line the diff shows, context and added, with its line number. */
function headLines(diff: string): HeadLine[] {
  const lines: HeadLine[] = [];
  let path = "";
  let line = 0;
  for (const row of diff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (row.startsWith("+++ ")) path = row.slice(4).replace(/^b\//, "");
    else if (hunk) line = Number(hunk[1]);
    else if (row.startsWith("+") || row.startsWith(" ")) lines.push({ path, line: line++, text: row.slice(1) });
  }
  return lines;
}

/** The finding moved onto the head-side line its `code` names, nearest the model's line, when the diff shows it. */
function anchored(finding: Finding, lines: readonly HeadLine[]): Finding {
  const code = finding.code?.split("\n").find((row) => row.trim() !== "")?.trim();
  if (!code) return finding;
  const matches = lines.filter((l) => samePath(finding.path, l.path) && l.text.trim() === code);
  if (matches.length === 0) return finding;
  function distance(l: HeadLine): number {
    return Math.abs(l.line - finding.start);
  }
  const nearest = matches.reduce((best, l) => (distance(l) < distance(best) ? l : best));
  return { ...finding, start: nearest.line, end: nearest.line + finding.end - finding.start };
}

/** Findings re-anchored on `diff`, and how many moved. */
export function reanchor(findings: readonly Finding[], diff: string): { findings: Finding[]; moved: number } {
  const lines = headLines(diff);
  const moved = findings.map((finding) => anchored(finding, lines));
  return { findings: moved, moved: moved.filter((finding, i) => finding.start !== findings[i]?.start).length };
}
